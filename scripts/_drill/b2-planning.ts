// ---------------------------------------------------------------------------
// DRILL: unified handoff batch 2 — PLANNING (R01, §6.4, §11), Sep 25 2026.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/b2-planning.ts
//
// OLD behaviour first wherever it can be observed: the modules at f2555f7
// (the tree batch 2 starts from — pinned, never HEAD) are loaded for real,
// their `@/` imports pointed at this tree, and run on the same rows.
//
//    1. The rule, pure: allowance order (carryover first, proposals last),
//       every topic step, the month headline.
//    2. The TEST shape (owed 2, three SELECTED, no row flag) through every
//       reader: planModel, Home, portalPlanning, monthProgress, the filming
//       gate's topics, the drafting sweep. OLD said "2 chosen, 3 need answers".
//    3. Call material and review states: a topic picked in the portal and
//       discussed on the call is WRITING (FROM_CALL); confidential-only is a
//       gap; a script in internal review is not "needs answers"; an approved
//       carryover consumes a slot first; another month's import hides nothing.
//    4. The written gate: an unanswered extra no longer holds filming shut;
//       no answers reminder for it; Pro's session 2 is not held by an extra.
//    5. Route choice: the first call is required, later months are optional;
//       an explicit mode wins; choosing stamps planningChosenAt.
//    6. Route switch round trip: same ids, no call / request / AI run.
//    7. Schedule later: stamped, idempotent, survives a refresh, the reminder
//       lane unchanged; booking completes the step; read-only is refused.
//    8. Call route: filming opens the moment the call is booked, and stays
//       open WHILE the call is happening; the clock runs from its end.
//    9. Written route + a call to discuss scripts: new offers respect the
//       buffer; a booked shoot inside it is an exception and a Kyle desk task.
//   10. Your Month: exactly one current step, on a table of states.
//   11. Plain labels.
//
// ISOLATION: PGlite on 127.0.0.1:5621 (the harness). Production is never
// opened; every non-loopback call is fenced and counted; nothing is sent.
// THE CLOCK IS PINNED to Wed Oct 7 2026 10:00 ET — the preparation window is
// weekday hours, so a real clock on a weekend would answer another question.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import type { PortalViewer } from "@/lib/portal";
import type { TopicPlanFacts } from "@/lib/planningState";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5621);
const BASE = "f2555f7"; // pinned: the tree batch 2 starts from, never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 7, 14, 0, 0); // Wed Oct 7 2026, 10:00 EDT
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
/** An ET wall clock in 2026 (EDT = UTC-4 until Nov 1). */
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

// ---- element trees -----------------------------------------------------------
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

// ---- the old code, runnable ------------------------------------------------------
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "b2-planning-base-"));
fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseDir, "node_modules"));
const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
async function loadBase<T>(rel: string): Promise<T> {
  const file = path.join(baseDir, rel.replace(/\//g, "__"));
  fs.writeFileSync(file, show(rel).replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`));
  return (await import(file)) as T;
}
const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
/** Source with comments removed — a label in a comment is not a label on screen. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const ps = await import("@/lib/planningState");
  const pm = await import("@/lib/programMonths");
  const portal = await import("@/lib/portal");
  const home = await import("@/lib/portalHome");
  const words = await import("@/lib/portalWords");
  const ym = await import("@/lib/yourMonth");
  const mp = await import("@/lib/monthProgress");
  const drafting = await import("@/lib/contentDrafting");
  const topicsLib = await import("@/lib/contentTopics");
  const reminders = await import("@/lib/programReminders");
  const actions = await import("@/app/portal/actions");
  const { PortalPage } = await import("@/components/portal/PortalPage");
  const { YourMonth } = await import("@/components/portal/YourMonth");
  const oldHome = await loadBase<typeof import("@/lib/portalHome")>("src/lib/portalHome.ts");
  const oldPM = await loadBase<typeof import("@/lib/programMonths")>("src/lib/programMonths.ts");
  const oldDraft = await loadBase<typeof import("@/lib/contentDrafting")>("src/lib/contentDrafting.ts");
  const oldProgress = await loadBase<typeof import("@/lib/monthProgress")>("src/lib/monthProgress.ts");
  const MONTH = "2026-10";

  const viewerOf = async (token: string | null): Promise<PortalViewer> => {
    const r = await portal.resolvePortalViewer({ token: token ?? "" });
    if (!r.ok) throw new Error(`viewer did not resolve: ${r.reason}`);
    return r.viewer;
  };
  const ownerOf = (v: PortalViewer, f: { clientUserId: string | null; membershipId: string | null }): PortalViewer =>
    ({ ...v, actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: "owner@example.com", name: "Owner", membershipId: f.membershipId!, membershipRole: "OWNER" }, via: "LOGIN" });
  const interview = (f: { enrollmentId: string; clientId: string; monthId: string }, topicId: string, status: string, submittedAt: Date | null, sufficiency: unknown = { sufficient: true, missing: [] }) =>
    prisma.contentInterview.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, topicId, status, submittedAt, sufficiencyJson: sufficiency ? JSON.stringify(sufficiency) : null } });
  const homeActionsOf = async (v: PortalViewer) => {
    const tree = await PortalPage({ viewer: v, path: "/portal/[token]", query: { tab: "home" } });
    const a = find(tree, "HomeV2")[0]?.props.actions as { primary: { kind: string; count: number; href: string; cta: string } | null; more: { kind: string; count: number; href: string; cta: string }[] } | undefined;
    return a ? [a.primary, ...a.more].filter((x): x is NonNullable<typeof x> => !!x) : [];
  };

  try {
    // =======================================================================
    c.head("1 · the rule, pure (planningState)");
    // =======================================================================
    const sel = (topicId: string, status: string, rank: number, hour: number) => ({ topicId, status, rank, createdAt: new RealDate(RealDate.UTC(2026, 9, 1, hour)) });
    const a1 = ps.allowanceOrder([sel("A", "SELECTED", 1, 1), sel("B", "SELECTED", 2, 2), sel("C", "SELECTED", 3, 3)], 2);
    c.ok("TEST shape (owed 2, three SELECTED, no flag): A and B are the allowance, C is an extra", a1.get("A") === "IN" && a1.get("B") === "IN" && a1.get("C") === "EXTRA");
    const a2 = ps.allowanceOrder([sel("A", "SELECTED", 1, 1), sel("B", "SELECTED", 2, 2), sel("K", "CARRIED", 9, 9)], 2);
    c.ok("a CARRIED script consumes a slot FIRST (§6.3): K and A in, B extra", a2.get("K") === "IN" && a2.get("A") === "IN" && a2.get("B") === "EXTRA");
    const a3 = ps.allowanceOrder([sel("P", "PROPOSED", 1, 1), sel("A", "SELECTED", 2, 2)], 1);
    c.ok("a call's PROPOSED row comes last", a3.get("A") === "IN" && a3.get("P") === "EXTRA");
    c.ok("the extras count is monthCapacity's arithmetic (total − owed)", [...a1.values()].filter((x) => x === "EXTRA").length === 3 - 2);

    const F = (over: Partial<TopicPlanFacts>): TopicPlanFacts => ({ topicId: "t", selectionStatus: "SELECTED", filmed: false, script: null, interview: null, callExcerpts: 0, ...over });
    type Ctx = Parameters<typeof ps.topicPlanStep>[1];
    const W: Ctx = { route: "WRITTEN", call: "NONE", inAllowance: true };
    const step = (f: Partial<TopicPlanFacts>, ctx: Ctx = W) => ps.topicPlanStep(F(f), ctx);
    const hub = (o: Partial<NonNullable<TopicPlanFacts["script"]>> = {}) => ({ importedHere: false, hubScript: true, released: false, decidable: false, decision: null, ...o });
    const table: [string, ReturnType<typeof step>, string, number?][] = [
      ["a call-drafted script in INTERNAL_REVIEW → TEAM_REVIEW, not NEEDS_ANSWERS", step({ script: hub() }), "TEAM_REVIEW"],
      ["a CARRIED script the client approved → APPROVED", step({ selectionStatus: "CARRIED", script: hub({ released: true, decidable: true, decision: "APPROVED" }) }), "APPROVED"],
      ["shared, no decision on this version → READY_FOR_YOU", step({ script: hub({ released: true, decidable: true }) }), "READY_FOR_YOU"],
      ["they asked for changes → CHANGES_REQUESTED", step({ script: hub({ released: true, decidable: true, decision: "CHANGES_REQUESTED" }) }), "CHANGES_REQUESTED"],
      ["an import filed on THIS month → APPROVED (material)", step({ script: { importedHere: true, hubScript: false, released: false, decidable: false, decision: null } }), "APPROVED"],
      ["another month's import is never passed → the gap shows (NEEDS_ANSWERS)", step({ script: null }), "NEEDS_ANSWERS"],
      ["call route, call BOOKED → ON_CALL", step({}, { route: "CALL", call: "BOOKED", inAllowance: true }), "ON_CALL"],
      ["call route, call HELD, excerpts only on a DISCUSSED event (2) → WRITING", step({ callExcerpts: 2 }, { route: "CALL", call: "HELD", inAllowance: true }), "WRITING"],
      ["call route, call HELD and READ (transcript analysed), nothing usable → NEEDS_MORE (asked after the call)", step({}, { route: "CALL", call: "HELD", inAllowance: true, callRead: true }), "NEEDS_MORE"],
      ["call route, call HELD but NOT read yet, nothing usable → WRITING (the team's move — never a questionnaire)", step({}, { route: "CALL", call: "HELD", inAllowance: true }), "WRITING"],
      ["call route, held not read, but the interview STORED gaps → NEEDS_MORE (a real gap is asked)", step({ interview: { status: "NEEDS_FOLLOWUP", missing: 1, sufficient: false } }, { route: "CALL", call: "HELD", inAllowance: true }), "NEEDS_MORE", 1],
      ["NEEDS_FOLLOWUP with one gap → NEEDS_MORE, missing 1", step({ interview: { status: "NEEDS_FOLLOWUP", missing: 1, sufficient: false } }), "NEEDS_MORE", 1],
      ["SUBMITTED but stored not-sufficient → NEEDS_MORE", step({ interview: { status: "SUBMITTED", missing: 2, sufficient: false } }), "NEEDS_MORE", 2],
      ["SUBMITTED and sufficient → WRITING", step({ interview: { status: "SUBMITTED", missing: 0, sufficient: true } }), "WRITING"],
      ["a PROPOSED selection → CONFIRMING", step({ selectionStatus: "PROPOSED" }), "CONFIRMING"],
      ["route not chosen, nothing started → CHOSEN", step({}, { route: "UNDECIDED", call: "NONE", inAllowance: true }), "CHOSEN"],
      ["route not chosen but they started answering → NEEDS_ANSWERS", step({ interview: { status: "IN_PROGRESS", missing: 0, sufficient: null } }, { route: "UNDECIDED", call: "NONE", inAllowance: true }), "NEEDS_ANSWERS"],
      ["outside the allowance → EXTRA whatever else", step({ interview: { status: "NOT_STARTED", missing: 0, sufficient: null } }, { ...W, inAllowance: false }), "EXTRA"],
      ["footage exists → FILMED, even for an extra", step({ filmed: true }, { ...W, inAllowance: false }), "FILMED"],
    ];
    for (const [label, got, want, missing] of table) c.ok(label, got.step === want && (missing === undefined || got.missing === missing), `${got.step}/${got.missing}`);

    const mk = (id: string, rank: number, over: Partial<TopicPlanFacts> = {}) => F({ topicId: id, rank, selectedAt: new RealDate(RealDate.UTC(2026, 9, 1, rank)), ...over });
    const mTest = ps.monthPlanning([mk("A", 1), mk("B", 2), mk("C", 3)], { route: "WRITTEN", call: "NONE", videosOwed: 2 });
    c.ok("month: chosen 2, extras 1, answers owed 2 (never 3)", mTest.chosen === 2 && mTest.extras === 1 && mTest.answersOwed === 2 && mTest.counts.EXTRA === 1);
    const headlines: [string, string][] = [
      [ps.monthPlanning([mk("A", 1, { interview: { status: "NEEDS_FOLLOWUP", missing: 1, sufficient: false } }), mk("B", 2, { interview: { status: "SUBMITTED", missing: 0, sufficient: true } })], { route: "WRITTEN", call: "NONE", videosOwed: 2 }).headline.text, "We need one more answer"],
      [mTest.headline.text, "We need your answers for 2 topics"],
      [ps.monthPlanning([mk("A", 1, { script: hub({ released: true, decidable: true }) }), mk("B", 2, { script: hub() })], { route: "WRITTEN", call: "NONE", videosOwed: 2 }).headline.text, "A script is ready for your review"],
      [ps.monthPlanning([mk("A", 1, { interview: { status: "SUBMITTED", missing: 0, sufficient: true } }), mk("B", 2, { script: hub() })], { route: "WRITTEN", call: "NONE", videosOwed: 2 }).headline.text, "We're writing your scripts"],
      [ps.monthPlanning([mk("A", 1, { script: hub() }), mk("B", 2, { script: hub() })], { route: "WRITTEN", call: "NONE", videosOwed: 2 }).headline.text, "Our team is reviewing your scripts"],
      [ps.monthPlanning([mk("A", 1), mk("B", 2)], { route: "CALL", call: "BOOKED", videosOwed: 2 }).headline.text, "We'll plan these on your call"],
      [ps.monthPlanning([mk("A", 1, { script: hub({ released: true, decidable: true, decision: "APPROVED" }) }), mk("B", 2, { script: hub({ released: true, decidable: true, decision: "APPROVED" }) })], { route: "WRITTEN", call: "NONE", videosOwed: 2 }).headline.text, "All 2 scripts approved"],
    ];
    for (const [got, want] of headlines) c.ok(`headline "${want}"`, got === want, got);
    const half = ps.monthPlanning([mk("A", 1, { script: hub({ released: true, decidable: true, decision: "APPROVED" }) }), mk("B", 2, { script: hub() }), mk("C", 3), mk("D", 4)], { route: "WRITTEN", call: "NONE", videosOwed: 4 });
    c.ok("precise progress: '1 of 4 scripts approved'", half.progress === "1 of 4 scripts approved", half.progress ?? "null");
    c.ok("the step words (§11): one more answer / writing / our team / ready for you", words.planStepWord("NEEDS_MORE", 1).label === "We need one more answer" && words.PLAN_STEP_WORDS.WRITING.label === "We're writing your script" && words.PLAN_STEP_WORDS.TEAM_REVIEW.label === "Our team is reviewing" && words.PLAN_STEP_WORDS.READY_FOR_YOU.label === "Ready for your review");

    // =======================================================================
    c.head("2 · the TEST shape through every reader (OLD first)");
    // =======================================================================
    const T = await buildContentMonth(prisma as never, { name: "Ada Planning TEST", package: "Starter", project: false, topics: [{ title: "Kitchen reveal walkthrough", selection: "SELECTED" }, { title: "Market update for October", selection: "SELECTED" }, { title: "Staging on a budget", selection: "SELECTED" }] });
    await prisma.contentMonth.update({ where: { id: T.monthId }, data: { planningMode: "WRITTEN" } });
    const [TA, TB, TC] = T.topicIds;
    const vT = await viewerOf(T.portalToken);
    const ownerT = ownerOf(vT, T);
    const tp = await portal.portalTopics(vT.enrollment);
    const oldPlan = oldHome.planModel(tp as never, MONTH);
    c.ok("OLD (f2555f7): 2 chosen but 3 need answers — the TEST portal's own Home", oldPlan.month?.selected === 2 && oldPlan.toAnswer.length === 3, `${oldPlan.month?.selected} / ${oldPlan.toAnswer.length}`);
    const plan = home.planModel(tp, MONTH);
    c.ok("NEW: 2 chosen, 1 extra, 2 need answers — the extra is not asked", plan.month?.selected === 2 && plan.month.overflow === 1 && plan.toAnswer.length === 2 && !plan.toAnswer.some((t) => t.id === TC), `${plan.month?.selected}+${plan.month?.overflow} / ${plan.toAnswer.map((t) => t.title).join(",")}`);
    const rowC = tp.groups.flatMap((g) => g.topics).find((t) => t.id === TC)!;
    const storedC = await prisma.contentTopicSelection.findFirst({ where: { topicId: TC, monthId: T.monthId }, select: { overflow: true } });
    c.ok("the third row is tagged extra from the DERIVED allowance (its stored flag is false)", rowC.selection?.overflow === true && rowC.plan?.step === "EXTRA" && storedC?.overflow === false);
    c.ok("the month's headline and progress come from the reader", tp.months[0]?.planning?.headline.text === "We need your answers for 2 topics");
    const ans = (await homeActionsOf(ownerT)).find((a) => a.kind === "ANSWER_QUESTIONS");
    c.ok("Home: ANSWER_QUESTIONS counts 2 and opens Your Month at the answers step", ans?.count === 2 && ans.href === "?tab=plan#step-answers", `${ans?.count} ${ans?.href}`);
    const pl = await portal.portalPlanning(vT.enrollment);
    c.ok("portalPlanning: 2 interviews owed (the extra is not one)", pl?.interviewsOpen === 2 && pl.answersSubmitted === false, `${pl?.interviewsOpen}`);
    // The double count: a stored flag on the extra AND its topic pointer.
    await prisma.contentTopicSelection.updateMany({ where: { topicId: TC, monthId: T.monthId }, data: { overflow: true } });
    const oldProg = await oldProgress.monthProgress(T.enrollmentId, T.monthId);
    const newProg = await mp.monthProgress(T.enrollmentId, T.monthId);
    c.ok("OLD: monthProgress counted the extra twice (3 selected + 1 overflow for 3 topics)", oldProg?.topics.selected === 3 && oldProg.topics.overflow === 1, `${oldProg?.topics.selected}+${oldProg?.topics.overflow}`);
    c.ok("NEW: 2 selected + 1 overflow, and its planning agrees with the portal", newProg?.topics.selected === 2 && newProg.topics.overflow === 1 && newProg.planning?.chosen === 2 && newProg.planning.answersOwed === 2, `${newProg?.topics.selected}+${newProg?.topics.overflow}`);
    const oldR = await oldPM.recalcProgramMonth(T.monthId, { dryRun: true });
    const newR = await pm.recalcProgramMonth(T.monthId, { dryRun: true });
    c.ok("OLD: the filming gate's session carried the extra as required material", !!oldR?.after.sessions[0]?.topicIds.includes(TC));
    c.ok("NEW: the session is the allowance only (A, B)", JSON.stringify([...(newR?.after.sessions[0]?.topicIds ?? [])].sort()) === JSON.stringify([TA, TB].sort()));
    const oldWork = await oldDraft.scriptWorkForMonth(T.monthId);
    const newWork = await drafting.scriptWorkForMonth(T.monthId);
    c.ok("OLD: the drafting sweep listed the extra as owed (THIN)", oldWork.find((w) => w.topicId === TC)?.readiness === "THIN");
    c.ok("NEW: the extra reads EXTRA — never auto-drafted", newWork.find((w) => w.topicId === TC)?.readiness === "EXTRA" && !drafting.isAutoDraftable("EXTRA"));

    // =======================================================================
    c.head("3 · call material, review states, carryover, imports");
    // =======================================================================
    const U = await buildContentMonth(prisma as never, {
      name: "Ben Callpath TEST", package: "Accelerator", project: false,
      topics: [
        { title: "Why I price homes to sell", selection: "SELECTED", source: "client" },
        { title: "Neighborhood secrets", selection: "SELECTED" },
        { title: "Staging mistakes sellers make", selection: "SELECTED" },
        { title: "Open house hacks", selection: "SELECTED" },
        { title: "Carried listing tips", selection: "SELECTED" },
      ],
    });
    const [UD, UE, UF, UH, UG] = U.topicIds;
    const call = await prisma.programCallRecord.create({ data: { enrollmentId: U.enrollmentId, clientId: U.clientId, callType: "MONTHLY_STRATEGY", monthId: U.monthId, status: "COMPLETED", matchState: "MATCHED", scheduledStart: et(10, 5, 13), scheduledEnd: et(10, 5, 13, 30), transcriptState: "ANALYZED" } });
    // G: carried in with a script the client approved — consumes a slot first.
    await prisma.contentTopicSelection.updateMany({ where: { topicId: UG, monthId: U.monthId }, data: { status: "CARRIED", rank: 9 } });
    const gScript = await prisma.contentScript.create({ data: { enrollmentId: U.enrollmentId, clientId: U.clientId, monthId: U.monthId, topicId: UG, title: "Carried listing tips", body: "b", status: "APPROVED", releaseState: "released" } });
    const gVer = await prisma.contentScriptVersion.create({ data: { scriptId: gScript.id, enrollmentId: U.enrollmentId, clientId: U.clientId, versionNo: 1, title: "Carried listing tips", hook: "h", pointsJson: "[]", close: "c", body: "b", source: "AI", status: "SHARED" } });
    await prisma.contentScript.update({ where: { id: gScript.id }, data: { sharedVersionId: gVer.id, approvedVersionId: gVer.id, currentVersionId: gVer.id } });
    await prisma.contentScriptRelease.create({ data: { scriptId: gScript.id, scriptVersionId: gVer.id, enrollmentId: U.enrollmentId, clientId: U.clientId, monthId: U.monthId, action: "CLIENT_APPROVED" } });
    // F: a call-drafted script in internal review.
    const fScript = await prisma.contentScript.create({ data: { enrollmentId: U.enrollmentId, clientId: U.clientId, monthId: U.monthId, topicId: UF, title: "Staging mistakes", body: "b", status: "INTERNAL_REVIEW" } });
    const fVer = await prisma.contentScriptVersion.create({ data: { scriptId: fScript.id, enrollmentId: U.enrollmentId, clientId: U.clientId, versionNo: 1, title: "Staging mistakes", hook: "h", pointsJson: "[]", close: "c", body: "b", source: "AI", status: "INTERNAL_REVIEW" } });
    await prisma.contentScript.update({ where: { id: fScript.id }, data: { currentVersionId: fVer.id } });
    // D and E: picked in the portal first, then the call analysis re-mentions
    // them — the SHIPPED write path, which keeps the selection and files the
    // excerpts on a DISCUSSED event (contentTopics' KEPT branch).
    const aiActor = { kind: "AI" as const };
    const dKept = await topicsLib.selectTopicForMonth(UD, U.monthId, { source: "call", actor: aiActor, callRecordId: call.id, status: "PROPOSED", evidence: { excerpts: [{ speaker: "client", text: "Honestly most sellers overprice by five percent and sit for months." }, { speaker: "client", text: "I tell them the first two weeks decide everything about the sale." }] } });
    const eKept = await topicsLib.selectTopicForMonth(UE, U.monthId, { source: "call", actor: aiActor, callRecordId: call.id, status: "PROPOSED", evidence: { excerpts: [{ speaker: "client", text: "[CONFIDENTIAL] the builder on Elm is going under next month, keep it quiet." }] } });
    c.ok("the call re-mention took the KEPT branch for both (selection untouched, excerpts on an event)", dKept.outcome === "KEPT" && eKept.outcome === "KEPT" && !(await prisma.contentTopicSelection.findFirst({ where: { topicId: UD, monthId: U.monthId }, select: { evidenceJson: true } }))?.evidenceJson);
    const vU = await viewerOf(U.portalToken);
    const tpU = await portal.portalTopics(vU.enrollment);
    const stepU = (id: string) => tpU.groups.flatMap((g) => g.topics).find((t) => t.id === id)?.plan?.step ?? null;
    c.ok("G (carried, client-approved) → APPROVED and IN — it took a slot first", stepU(UG) === "APPROVED");
    c.ok("D (portal pick + 2 client lines on the call) → WRITING", stepU(UD) === "WRITING");
    c.ok("E (confidential-only on the call, call held) → NEEDS_MORE, asked after the call", stepU(UE) === "NEEDS_MORE");
    c.ok("F (script in internal review) → TEAM_REVIEW", stepU(UF) === "TEAM_REVIEW");
    c.ok("H (fifth of four) → EXTRA", stepU(UH) === "EXTRA");
    const oldPlanU = oldHome.planModel(tpU as never, MONTH);
    const planU = home.planModel(tpU, MONTH);
    c.ok("OLD: every one of the five 'needed answers'", oldPlanU.toAnswer.length === 5, String(oldPlanU.toAnswer.length));
    c.ok("NEW: only E (a genuine gap after the call)", planU.toAnswer.length === 1 && planU.toAnswer[0].id === UE, planU.toAnswer.map((t) => t.title).join(","));
    const workU = await drafting.scriptWorkForMonth(U.monthId);
    const oldWorkU = await oldDraft.scriptWorkForMonth(U.monthId);
    c.ok("OLD: D read THIN (the drafting sweep read selection evidence only)", oldWorkU.find((w) => w.topicId === UD)?.readiness === "THIN");
    c.ok("NEW: D is FROM_CALL with 2 excerpts; E (confidential-only) stays THIN", workU.find((w) => w.topicId === UD)?.readiness === "FROM_CALL" && workU.find((w) => w.topicId === UD)?.excerpts === 2 && workU.find((w) => w.topicId === UE)?.readiness === "THIN");
    // The roster shortcut (a client with no confidential fact is tested on the
    // two markers alone) must read exactly as clientFacts.confidentialFilter.
    const { confidentialFilter } = await import("@/lib/clientFacts");
    const { markedConfidential } = await import("@/lib/planningFacts");
    const fullTest = await confidentialFilter(U.clientId);
    const samples = ["[CONFIDENTIAL] the builder on Elm is going under", "Keep this between us, the listing is not public yet", "Most sellers overprice by five percent and sit for months", ""];
    c.ok("the batched confidentiality shortcut agrees with confidentialFilter for a client with no confidential facts", samples.every((t) => fullTest(t) === markedConfidential(t)));
    await prisma.clientFact.create({ data: { clientId: U.clientId, enrollmentId: U.enrollmentId, category: "DECISION", body: "Most sellers overprice by five percent and sit for months", source: "call", status: "ACCEPTED", confidential: true } });
    const dAfterFact = (await (await import("@/lib/planningFacts")).planningForMonth(U.monthId))?.facts.find((f) => f.topicId === UD)?.callExcerpts;
    c.ok("…and a client WITH a confidential fact goes through confidentialFilter itself (the overlapping line stops counting)", dAfterFact === 1, String(dAfterFact));
    await prisma.clientFact.deleteMany({ where: { clientId: U.clientId } });
    const ownerU = ownerOf(vU, U);
    const ansU = (await homeActionsOf(ownerU)).find((a) => a.kind === "ANSWER_QUESTIONS");
    c.ok("Home on the CALL route asks the one real gap after the call", ansU?.count === 1);
    // Imports: this month's vs another month's.
    const I = await buildContentMonth(prisma as never, { name: "Cara Imports TEST", package: "Starter", project: false, topics: [{ title: "First-time buyer mistakes", selection: "SELECTED" }, { title: "Why staging pays", selection: "SELECTED" }] });
    await prisma.contentMonth.update({ where: { id: I.monthId }, data: { planningMode: "WRITTEN" } });
    const sep = await prisma.contentMonth.create({ data: { enrollmentId: I.enrollmentId, clientId: I.clientId, monthKey: "2026-09", videosOwed: 2, status: "CLOSED" } });
    await prisma.contentScript.create({ data: { enrollmentId: I.enrollmentId, clientId: I.clientId, monthId: sep.id, topicId: I.topicIds[0], title: "old import", body: "b", status: "APPROVED", historical: true, releaseState: "historical", source: "import" } });
    await prisma.contentScript.create({ data: { enrollmentId: I.enrollmentId, clientId: I.clientId, monthId: I.monthId, topicId: I.topicIds[1], title: "this month's import", body: "b", status: "APPROVED", historical: true, releaseState: "historical", source: "import" } });
    const tpI = await portal.portalTopics((await viewerOf(I.portalToken)).enrollment);
    const stepI = (id: string) => tpI.groups.flatMap((g) => g.topics).find((t) => t.id === id)?.plan?.step ?? null;
    c.ok("an import filed on ANOTHER month does not hide the gap (NEEDS_ANSWERS)", stepI(I.topicIds[0]) === "NEEDS_ANSWERS");
    c.ok("an import filed on THIS month counts as material (APPROVED)", stepI(I.topicIds[1]) === "APPROVED");

    // =======================================================================
    c.head("4 · the written gate: an extra never holds filming shut (OLD first)");
    // =======================================================================
    await interview(T, TA, "SUBMITTED", et(10, 5, 14, 30));
    const lastSubmit = et(10, 7, 8);
    await interview(T, TB, "SUBMITTED", lastSubmit);
    const oldGate = await oldPM.recalcProgramMonth(T.monthId, { dryRun: true });
    c.ok("OLD: A and B answered, the extra not — the gate stayed shut, AWAITING_ANSWERS (the answers reminder's driver)", oldGate?.after.earliestSessionAt === null && oldGate.after.preparationStatus === "AWAITING_ANSWERS", `${oldGate?.after.preparationStatus}`);
    const newGate = await pm.recalcProgramMonth(T.monthId, { dryRun: true });
    const expectEarliest = pm.earliestFilmingStart(lastSubmit, { windowHours: newGate!.after.windowHours, windowWaived: false });
    c.ok("NEW: open, earliest = the last submission + the window (not the extra's)", newGate?.after.earliestSessionAt?.getTime() === expectEarliest.getTime() && newGate.after.preparationStatus === "PREPARING_SCRIPTS", newGate?.after.earliestSessionAt?.toISOString());
    const gateT = await portal.sessionGate(T.enrollmentId, T.monthId, { now: NOW });
    // 72 weekday hours since batch 3, §3: Wed 08:00 → Mon Oct 12 08:00 (was Fri Oct 9 under 48).
    c.ok("…and the portal's gate says the same (Mon Oct 12, 08:00 ET)", !gateT.locked && gateT.earliest.getTime() === expectEarliest.getTime() && expectEarliest.getTime() === et(10, 12, 8).getTime(), gateT.earliest.toISOString());
    const prevT = await reminders.previewReminders(T.monthId, { now: NOW });
    const primaryT = prevT.lanes.find((l) => l.lane === "PRIMARY")?.candidate.action ?? null;
    c.ok("the reminder evaluator produces no COMPLETE_ANSWERS for the extra (it moves on to booking)", primaryT !== "COMPLETE_ANSWERS" && primaryT === "BOOK_SESSION", String(primaryT));
    const P = await buildContentMonth(prisma as never, { name: "Dan Pro TEST", package: "Pro", project: false, topics: Array.from({ length: 9 }, (_, i) => ({ title: `Pro topic ${i + 1}`, selection: "SELECTED" as const })) });
    await prisma.contentMonth.update({ where: { id: P.monthId }, data: { planningMode: "WRITTEN" } });
    for (const [i, id] of P.topicIds.slice(0, 8).entries()) await interview(P, id, "SUBMITTED", et(10, 5, 9 + (i % 4)));
    const oldPro = await oldPM.recalcProgramMonth(P.monthId, { dryRun: true });
    const newPro = await pm.recalcProgramMonth(P.monthId, { dryRun: true });
    c.ok("OLD: Pro's session 2 carried the unanswered extra and stayed shut", oldPro?.after.sessions.length === 2 && oldPro.after.sessions[1].earliestSessionAt === null && oldPro.after.sessions[1].topicIds.includes(P.topicIds[8]));
    c.ok("NEW: both sessions open, 4 + 4, the extra in neither", newPro?.after.sessions.length === 2 && newPro.after.sessions.every((s) => s.earliestSessionAt !== null && s.topicIds.length === 4 && !s.topicIds.includes(P.topicIds[8])));

    // =======================================================================
    c.head("5 · route choice: the first call is required, later ones optional");
    // =======================================================================
    const eff = (e: { callMode: string | null; strategyCallRequired: boolean; noCallEligible?: boolean | null }, prior: boolean) => pm.effectiveCallMode(e, { priorProgramCallHeld: prior });
    c.ok("legacy (no column, flag true), no call held yet → REQUIRED", eff({ callMode: null, strategyCallRequired: true }, false) === "REQUIRED");
    c.ok("…after the first monthly call is held → OPTIONAL_WRITTEN", eff({ callMode: null, strategyCallRequired: true }, true) === "OPTIONAL_WRITTEN");
    c.ok("an explicit REQUIRED column stays REQUIRED", eff({ callMode: "REQUIRED", strategyCallRequired: true }, true) === "REQUIRED");
    c.ok("noCallEligible = false keeps it call-only", eff({ callMode: null, strategyCallRequired: true, noCallEligible: false }, true) === "REQUIRED");
    c.ok("NOT_INCLUDED is unchanged", eff({ callMode: null, strategyCallRequired: false }, true) === "NOT_INCLUDED");
    const R = await buildContentMonth(prisma as never, { name: "Dee Route TEST", package: "Starter", project: false, topics: [{ title: "Pricing myths", selection: "SELECTED" }, { title: "Inspection tips", selection: "SELECTED" }] });
    const rSep = await prisma.contentMonth.create({ data: { enrollmentId: R.enrollmentId, clientId: R.clientId, monthKey: "2026-09", videosOwed: 2, status: "OPEN" } });
    await prisma.programCallRecord.create({ data: { enrollmentId: R.enrollmentId, clientId: R.clientId, callType: "MONTHLY_STRATEGY", monthId: rSep.id, status: "COMPLETED", matchState: "MATCHED", scheduledStart: et(9, 3, 13), scheduledEnd: et(9, 3, 13, 30), transcriptState: "ANALYZED" } });
    const recalcR = await pm.recalcProgramMonth(R.monthId, { dryRun: true });
    const oldRecalcR = await oldPM.recalcProgramMonth(R.monthId, { dryRun: true });
    c.ok("OLD: month 2 was call-only for ever (REQUIRED, CALL)", oldRecalcR?.after.callMode === "REQUIRED" && oldRecalcR.after.planningMode === "CALL");
    c.ok("NEW: month 2 after a held call is OPTIONAL_WRITTEN and undecided", recalcR?.after.callMode === "OPTIONAL_WRITTEN" && recalcR.after.planningMode === "UNDECIDED");
    c.ok("…while month 1 (whose own call it was) stays REQUIRED", (await pm.recalcProgramMonth(rSep.id, { dryRun: true }))?.after.callMode === "REQUIRED");
    const vR = await viewerOf(R.portalToken);
    const plR = await portal.portalPlanning(vR.enrollment);
    c.ok("portalPlanning offers both routes, nothing chosen yet", plR?.noCallEligible === true && plR.callMode === "OPTIONAL_WRITTEN" && plR.chosenAtISO === null);
    const prevR = await reminders.previewReminders(R.monthId, { now: NOW });
    c.ok("the reminder evaluator asks CHOOSE_PATH, never a mandatory BOOK_CALL", prevR.lanes.find((l) => l.lane === "PRIMARY")?.candidate.action === "CHOOSE_PATH", String(prevR.lanes.find((l) => l.lane === "PRIMARY")?.candidate.action));
    const ownerR = ownerOf(vR, R);
    const routeAct = (await homeActionsOf(ownerR)).find((a) => a.kind === "CHOOSE_ROUTE" || a.kind === "BOOK_CALL");
    c.ok("Home asks which route (CHOOSE_ROUTE → #step-route), not 'Book your strategy call'", routeAct?.kind === "CHOOSE_ROUTE" && routeAct.href === "?tab=plan#step-route", `${routeAct?.kind} ${routeAct?.href}`);
    const planPageR = await PortalPage({ viewer: ownerR, path: "/portal/[token]", query: { tab: "plan" } });
    const planTabR = find(planPageR, "PlanTab")[0];
    const ymTreeR = planTabR?.props.d.yourMonth ? YourMonth({ d: { ...planTabR.props.d.yourMonth, topics: planTabR.props.d.topics, readOnly: false, hrefs: { month: "?tab=plan", bank: "?tab=plan&pv=bank", scripts: "?tab=plan&pv=scripts", schedule: "?tab=schedule" } } }) : null;
    const currentR = ymTreeR ? find(ymTreeR, "li").filter((e) => e.props["aria-current"] === "step") : [];
    c.ok("Your Month opens on the prompt: one current step, #step-route, with the two route cards", currentR.length === 1 && currentR[0].props.id === "step-route" && find(ymTreeR, "RouteChoice").length === 1, currentR.map((e) => e.props.id).join(","));
    const progR = await mp.monthProgress(R.enrollmentId, R.monthId);
    c.ok("staff: month 2 is not call-required, and the next step is the client's route choice", progR?.call.required === false && progR.call.mode === "OPTIONAL_WRITTEN" && progR.nextAction?.blocked === "client" && /haven't chosen how to plan/.test(progR.nextAction.text), progR?.nextAction?.text);
    const gateR = await portal.sessionGate(R.enrollmentId, R.monthId, { now: NOW });
    c.ok("an undecided month's filming lock says to choose the route (not 'book your call first')", gateR.locked && /Choose how to plan this month first/.test(gateR.reason), gateR.reason);
    {
      // Batch-2 review: Jordan's roster (programOverview) still read the legacy
      // call mode, so it chased a "required" call the portal offered as a choice.
      const ov = await import("@/lib/programOverview");
      const oldOv = await loadBase<typeof import("@/lib/programOverview")>("src/lib/programOverview.ts");
      const rowOf = async (m: typeof ov) => (await m.programOverview({ monthKey: MONTH, enrollmentIds: [R.enrollmentId], now: NOW })).rows.find((r) => r.monthId === R.monthId) ?? null;
      const oldRow = await rowOf(oldOv as typeof ov);
      const newRow = await rowOf(ov);
      c.ok("OLD overview: 'Call required', and 'Strategy call is required and nothing is booked'", oldRow?.planning.callMode === "REQUIRED" && /required and nothing is booked/.test(oldRow.nextAction.text), `${oldRow?.planning.callMode} / ${oldRow?.nextAction.text}`);
      c.ok("NEW overview agrees with the portal and monthProgress: OPTIONAL_WRITTEN, undecided, the client's choice to make", newRow?.planning.callMode === "OPTIONAL_WRITTEN" && newRow.planning.planningMode === "UNDECIDED" && newRow.nextAction.blocked === "client" && !/required/i.test(newRow.nextAction.text), `${newRow?.planning.callMode} / ${newRow?.planning.planningMode} / ${newRow?.nextAction.text}`);
      c.ok("…and Jordan's 'Missing planning' filter now lists it", !!newRow?.flags.includes("missing_planning") && !oldRow?.flags.includes("missing_planning"), newRow?.flags.join(","));
    }
    const undecided = (scripts: { status: string; approvedVersionId: string | null; approvedAt?: Date | null }[]) => pm.deriveMonthState({
      now: NOW, month: { strategyCallStatus: "NOT_SCHEDULED", strategyCallAt: null, transcriptText: null, planningMode: null, preparationStatus: null, preparationCompletedAt: null, preparationWindowDays: null, preparationExceptionAt: null, preparationExceptionReason: null, filmingReadyAt: null, historical: false },
      enrollment: { callMode: null, strategyCallRequired: true, noCallEligible: null, priorCallHeld: true }, records: [], scripts, interviews: [],
    });
    c.ok("an undecided month WITH approved scripts still reads prepared (scripts are proof it was planned)", undecided([{ status: "APPROVED", approvedVersionId: "v1", approvedAt: et(10, 2, 9) }]).preparationStatus === "READY_FOR_FILMING");
    c.ok("…and one with nothing yet has no preparation status (not CALL_PLANNED)", undecided([]).preparationStatus === null && undecided([]).planningMode === "UNDECIDED");
    // The first month of a program: call only.
    const Q = await buildContentMonth(prisma as never, { name: "Eve First TEST", package: "Starter", project: false, topics: [{ title: "Hello topic", selection: "SELECTED" }] });
    const plQ = await portal.portalPlanning((await viewerOf(Q.portalToken)).enrollment);
    c.ok("a first month (no call held yet) is call-only: REQUIRED, CALL, no written offer", plQ?.callMode === "REQUIRED" && plQ.planningMode === "CALL" && plQ.noCallEligible === false);
    c.ok("…the evaluator asks BOOK_CALL there", (await reminders.previewReminders(Q.monthId, { now: NOW })).lanes.find((l) => l.lane === "PRIMARY")?.candidate.action === "BOOK_CALL");
    const refusedQ = await actions.portalPlanWithoutCall({ token: Q.portalToken }, Q.monthId);
    c.ok("…and 'Choose my topics here' is refused on it", !refusedQ.ok, refusedQ.message);
    const before = { calls: await prisma.programCallRecord.count(), reqs: await prisma.programSessionRequest.count() };
    const chose = await actions.portalPlanWithoutCall({ token: R.portalToken }, R.monthId);
    const rRow = await prisma.contentMonth.findUnique({ where: { id: R.monthId }, select: { planningMode: true, planningChosenAt: true, planningChosenBy: true } });
    c.ok("choosing WRITTEN stamps planningChosenAt/By (the link seat)", chose.ok && rRow?.planningMode === "WRITTEN" && Math.abs((rRow.planningChosenAt?.getTime() ?? 0) - NOW.getTime()) < 10 * 60_000 && rRow.planningChosenBy === "link", chose.message);
    c.ok("…and never touches a call record or a session request", (await prisma.programCallRecord.count()) === before.calls && (await prisma.programSessionRequest.count()) === before.reqs);

    // =======================================================================
    c.head("6 · route switch round trip: nothing lost, nothing duplicated");
    // =======================================================================
    const rIv = await interview(R, R.topicIds[0], "IN_PROGRESS", null, null);
    const rScript = await prisma.contentScript.create({ data: { enrollmentId: R.enrollmentId, clientId: R.clientId, monthId: R.monthId, topicId: R.topicIds[1], title: "Inspection tips", body: "b", status: "DRAFT" } });
    const ids = async () => ({
      sels: (await prisma.contentTopicSelection.findMany({ where: { monthId: R.monthId }, select: { id: true, status: true }, orderBy: { id: "asc" } })).map((x) => `${x.id}:${x.status}`).join(","),
      ivs: (await prisma.contentInterview.findMany({ where: { monthId: R.monthId }, select: { id: true }, orderBy: { id: "asc" } })).map((x) => x.id).join(","),
      scripts: (await prisma.contentScript.findMany({ where: { monthId: R.monthId }, select: { id: true }, orderBy: { id: "asc" } })).map((x) => x.id).join(","),
      calls: await prisma.programCallRecord.count(), reqs: await prisma.programSessionRequest.count(), runs: await prisma.programAiRun.count(),
    });
    const snap = await ids();
    const toCall = await actions.portalPlanWithCall({ token: R.portalToken }, R.monthId);
    const stepR = async (id: string) => (await portal.portalTopics(vR.enrollment)).groups.flatMap((g) => g.topics).find((t) => t.id === id)?.plan?.step ?? null;
    const onCallStep = await stepR(R.topicIds[0]);
    const toWritten = await actions.portalPlanWithoutCall({ token: R.portalToken }, R.monthId);
    const writtenStep = await stepR(R.topicIds[0]);
    const back = await actions.portalPlanWithCall({ token: R.portalToken }, R.monthId);
    const after = await ids();
    c.ok("CALL → WRITTEN → CALL all succeed", toCall.ok && toWritten.ok && back.ok, [toCall.message, toWritten.message, back.message].join(" | "));
    c.ok("the same selection, interview and script ids after the round trip", after.sels === snap.sels && after.ivs === snap.ivs && after.scripts === snap.scripts && snap.ivs.includes(rIv.id) && snap.scripts.includes(rScript.id));
    c.ok("0 call records, 0 session requests, 0 AI runs added", after.calls === snap.calls && after.reqs === snap.reqs && after.runs === snap.runs);
    c.ok("the step follows the route with no data change (ON_CALL on the call route, NEEDS_ANSWERS written)", onCallStep === "ON_CALL" && writtenStep === "NEEDS_ANSWERS", `${onCallStep} / ${writtenStep}`);

    // =======================================================================
    c.head("7 · Schedule later");
    // =======================================================================
    const schedT = async () => (await portal.portalScheduleMonths(vT.enrollment)).find((m) => m.monthId === T.monthId) ?? null;
    const stepsT = async () => {
      const p = (await portal.portalPlanning(vT.enrollment))!;
      const s = await schedT();
      return ym.yourMonthSteps({
        monthLabel: "October", planning: { callMode: p.callMode, planningMode: p.planningMode, callStatus: p.callStatus, callAtISO: p.callAtISO, noCallEligible: p.noCallEligible, chosenAtISO: p.chosenAtISO, deferredAtISO: p.deferredAtISO },
        month: p.planning!, can: { suggest: true, session: true }, readOnly: false,
        schedule: s ? { locked: s.locked, reason: s.reason, earliestISO: s.earliestISO, sessionsRequired: s.sessionsRequired, sessionsMissing: s.sessionsMissing, pendingRequest: false, capacityRemaining: s.capacity.remaining } : null,
        hrefs: { bank: "b", month: "m", scripts: "s", bookingUrl: "https://calendly.invalid" },
      });
    };
    const cur = (st: Awaited<ReturnType<typeof stepsT>>) => st.filter((x) => x.state === "current").map((x) => x.key).join(",");
    const s0 = await stepsT();
    c.ok("before: the answers are in and filming is the one current step", cur(s0) === "filming" && s0.find((x) => x.key === "answers")?.state === "done", cur(s0));
    const remBefore = (await reminders.previewReminders(T.monthId, { now: NOW })).lanes.map((l) => l.candidate.action);
    const later = await actions.portalScheduleLater({ token: T.portalToken }, T.monthId);
    const stamp1 = (await prisma.contentMonth.findUnique({ where: { id: T.monthId }, select: { schedulingDeferredAt: true, schedulingDeferredBy: true } }))!;
    await actions.portalScheduleLater({ token: T.portalToken }, T.monthId);
    const stamp2 = (await prisma.contentMonth.findUnique({ where: { id: T.monthId }, select: { schedulingDeferredAt: true } }))!;
    c.ok("Schedule later is stamped on the server, once (a second tap keeps the first stamp)", later.ok && !!stamp1.schedulingDeferredAt && stamp1.schedulingDeferredBy === "link" && stamp2.schedulingDeferredAt?.getTime() === stamp1.schedulingDeferredAt.getTime());
    c.ok("…and survives a refresh (portalPlanning reads it back)", (await portal.portalPlanning(vT.enrollment))?.deferredAtISO === stamp1.schedulingDeferredAt?.toISOString());
    const s1 = await stepsT();
    const film1 = s1.find((x) => x.key === "filming");
    c.ok("the filming step stays outstanding (current, 'You chose to schedule later')", cur(s1) === "filming" && /schedule later/i.test(film1?.detail ?? ""), film1?.detail ?? "");
    const remAfter = (await reminders.previewReminders(T.monthId, { now: NOW })).lanes.map((l) => l.candidate.action);
    c.ok("the reminder lanes are unchanged — one BOOK_SESSION on its normal cadence, no parallel stream", JSON.stringify(remAfter) === JSON.stringify(remBefore) && remAfter.filter((a) => a === "BOOK_SESSION").length === 1, JSON.stringify(remAfter));
    const bookT = (await homeActionsOf(ownerT)).find((a) => a.kind === "BOOK_SESSION");
    c.ok("Home keeps BOOK_SESSION waiting, 'Book filming' → #step-filming", bookT?.cta === "Book filming" && bookT.href === "?tab=plan#step-filming", `${bookT?.cta} ${bookT?.href}`);
    const planPageT = await PortalPage({ viewer: ownerT, path: "/portal/[token]", query: { tab: "plan" } });
    const ptT = find(planPageT, "PlanTab")[0];
    const ymT = ptT?.props.d.yourMonth ? YourMonth({ d: { ...ptT.props.d.yourMonth, topics: ptT.props.d.topics, readOnly: false, hrefs: { month: "?tab=plan", bank: "?tab=plan&pv=bank", scripts: "?tab=plan&pv=scripts", schedule: "?tab=schedule" } } }) : null;
    const curT = ymT ? find(ymT, "li").filter((e) => e.props["aria-current"] === "step") : [];
    c.ok("the page: one current step (#step-filming) with the embedded picker and the saved choice", curT.length === 1 && curT[0].props.id === "step-filming" && find(ymT, "PortalScheduler")[0]?.props.embedded === true && find(ymT, "ScheduleLaterButton")[0]?.props.deferred === true);
    await prisma.contentEnrollment.update({ where: { id: T.enrollmentId }, data: { status: "ENDED" } });
    const endedLater = await actions.portalScheduleLater({ token: T.portalToken }, T.monthId);
    c.ok("an ended (read-only) account gets no Schedule later", !endedLater.ok, endedLater.message);
    await prisma.contentEnrollment.update({ where: { id: T.enrollmentId }, data: { status: "ACTIVE" } });
    const proj = await prisma.project.create({ data: { clientId: T.clientId, title: "Ada — October content", status: "SCHEDULED", contentMonthId: T.monthId, packageName: "Video Starter", shootDate: et(10, 13, 10) } });
    await prisma.appointment.create({ data: { projectId: proj.id, aryeoId: "b2-appt-t-1", startAt: et(10, 13, 10), endAt: et(10, 13, 12), durationMin: 120, status: "SCHEDULED", title: "Content session 1" } });
    const s2 = await stepsT();
    c.ok("booking after deferring completes the step (the stamp stays as history)", s2.find((x) => x.key === "filming")?.state === "done" && !!(await prisma.contentMonth.findUnique({ where: { id: T.monthId }, select: { schedulingDeferredAt: true } }))?.schedulingDeferredAt);
    c.ok("…and Home no longer asks to book filming", !(await homeActionsOf(ownerT)).some((a) => a.kind === "BOOK_SESSION"));

    // =======================================================================
    c.head("8 · call route: filming opens the moment the call is booked (OLD first)");
    // =======================================================================
    const baseSrc = show("src/lib/portal.ts");
    c.ok("OLD: the booked-call branch read the call's START (`strategyCallAt > new Date()`)", /d\.strategyCallStatus === "SCHEDULED" && d\.strategyCallAt && d\.strategyCallAt > new Date\(\)/.test(baseSrc));
    const V = await buildContentMonth(prisma as never, { name: "Fay Midcall TEST", package: "Accelerator", project: false, topics: [{ title: "Topic one", selection: "SELECTED" }] });
    await prisma.programCallRecord.create({ data: { enrollmentId: V.enrollmentId, clientId: V.clientId, callType: "MONTHLY_STRATEGY", monthId: V.monthId, status: "SCHEDULED", matchState: "MATCHED", scheduledStart: et(10, 7, 9, 50), scheduledEnd: et(10, 7, 10, 20), transcriptState: "NONE" } });
    const midDerived = await pm.recalcProgramMonth(V.monthId, { dryRun: true, now: NOW });
    // Since batch 3 (§3, A19) the NEW derivation anchors a booked call itself,
    // so the old condition must be fed the OLD derivation (f2555f7's, which
    // opened the call route only once the call was HELD) to stay an OLD reading.
    const oldMid = await oldPM.recalcProgramMonth(V.monthId, { dryRun: true, now: NOW });
    const oldWouldLock = !(oldMid!.after.strategyCallAt! > NOW) && oldMid!.after.earliestSessionAt === null;
    c.ok("OLD (the same month through the old derivation and the old condition): 10 minutes into the call the gate had nothing to open on", oldWouldLock);
    const gateMid = await portal.sessionGate(V.enrollmentId, V.monthId, { now: NOW });
    const expectMid = pm.earliestFilmingStart(et(10, 7, 10, 20), { windowHours: midDerived!.after.windowHours, windowWaived: false });
    c.ok("NEW: 10 minutes into the call the gate is open, earliest = the call's END + the window", !gateMid.locked && gateMid.earliest.getTime() === expectMid.getTime(), `${gateMid.reason} ${gateMid.earliest.toISOString()}`);
    const X = await buildContentMonth(prisma as never, { name: "Gil Future TEST", package: "Accelerator", project: false, topics: [{ title: "Topic one", selection: "SELECTED" }] });
    await prisma.programCallRecord.create({ data: { enrollmentId: X.enrollmentId, clientId: X.clientId, callType: "MONTHLY_STRATEGY", monthId: X.monthId, status: "SCHEDULED", matchState: "MATCHED", scheduledStart: et(10, 12, 13), scheduledEnd: et(10, 12, 13, 30), transcriptState: "NONE" } });
    const gateX = await portal.sessionGate(X.enrollmentId, X.monthId, { now: NOW });
    // 72 weekday hours since batch 3, §3: Mon 13:30 end → Thu Oct 15 13:30 (was Wed Oct 14 under 48).
    c.ok("booked today for a call on Mon Oct 12: open now, measured from the call's end (Thu Oct 15 13:30), not the booking", !gateX.locked && gateX.earliest.getTime() === et(10, 15, 13, 30).getTime() && gateX.earliest.getTime() !== pm.addWeekdayHoursET(NOW, 72).getTime(), gateX.earliest.toISOString());

    // =======================================================================
    c.head("9 · written route + a call to discuss scripts: the buffer (OLD first)");
    // =======================================================================
    const bufInput = (withCall: boolean) => ({
      now: et(10, 6, 10),
      month: { strategyCallStatus: "NOT_SCHEDULED", strategyCallAt: null, transcriptText: null, planningMode: "WRITTEN", preparationStatus: null, preparationCompletedAt: null, preparationWindowDays: null, preparationExceptionAt: null, preparationExceptionReason: null, filmingReadyAt: null, historical: false },
      enrollment: { callMode: "OPTIONAL_WRITTEN", strategyCallRequired: true, noCallEligible: true },
      records: withCall ? [{ callType: "MONTHLY_STRATEGY", status: "SCHEDULED", matchState: "MATCHED", scheduledStart: et(10, 7, 14, 30), scheduledEnd: et(10, 7, 15), transcriptState: "NONE" }] : [],
      scripts: [], interviews: [{ topicId: "A", status: "SUBMITTED", submittedAt: et(10, 5, 9) }],
      topics: [{ topicId: "A", status: "SELECTED", title: "A", createdAt: et(10, 1, 9), scriptApproved: false, scriptApprovedAt: null, interviewStatus: "SUBMITTED", interviewSubmittedAt: et(10, 5, 9), interviewSufficient: true }],
      plan: { videosPerMonth: 1, sessionsPerMonth: 1 },
      booking: pm.countDistinctSessions({ now: et(10, 6, 10), appointments: [{ appointmentId: "appt-thu", projectId: "p1", startAt: et(10, 8, 14), endAt: et(10, 8, 16), cancelled: false }], projects: [], confirmedRequests: [] }),
    });
    const oldBuf = oldPM.deriveMonthState(bufInput(true) as never);
    const newBuf = pm.deriveMonthState(bufInput(true));
    const noCall = pm.deriveMonthState(bufInput(false));
    c.ok("OLD: answers Mon, shoot Thu, call booked Wed ending 3pm — no exception, nothing for Kyle", oldBuf.exceptions.length === 0 && oldBuf.followUps.every((f) => f.kind !== ("CALL_INSIDE_BUFFER" as never)));
    c.ok("NEW: exactly one exception and one Kyle follow-up naming the Thu session", newBuf.exceptions.length === 1 && /buffer/.test(newBuf.exceptions[0]) && newBuf.followUps.filter((f) => f.kind === "CALL_INSIDE_BUFFER" && f.owner === "KYLE").length === 1, newBuf.exceptions[0]);
    const bufEnd = pm.earliestFilmingStart(et(10, 7, 15), { windowHours: newBuf.windowHours, windowWaived: false });
    // Label only: 72 weekday hours since batch 3, §3 (Wed 3pm → Mon 3pm; was Fri 3pm under 48).
    c.ok("new offers start no earlier than the call's end + the window (Wed 3pm → Mon 3pm at 72 weekday hours)", newBuf.earliestSessionAt?.getTime() === bufEnd.getTime() && noCall.earliestSessionAt!.getTime() < bufEnd.getTime(), newBuf.earliestSessionAt?.toISOString());
    c.ok("the booked session itself is untouched (still Thu 2pm)", newBuf.sessionsAccountedFor === 1 && bufInput(true).booking.sessions[0].startsAt?.getTime() === et(10, 8, 14).getTime());
    // Through recalcProgramMonth: a real-named client (made by hand, PGlite
    // only) gets the desk task; a TEST client never does.
    const realClient = await prisma.client.create({ data: { name: "Harper Lane Realty", socialClient: true, socialPlan: "Starter" }, select: { id: true } });
    const realE = await prisma.contentEnrollment.create({ data: { clientId: realClient.id, status: "ACTIVE", package: "Starter", videosPerMonth: 1, sessionsPerMonth: 1, sessionHours: 2, callMode: "OPTIONAL_WRITTEN", startedAt: et(8, 1, 0) }, select: { id: true } });
    const realM = await prisma.contentMonth.create({ data: { enrollmentId: realE.id, clientId: realClient.id, monthKey: MONTH, videosOwed: 1, status: "OPEN", planningMode: "WRITTEN" }, select: { id: true } });
    const realT = await prisma.contentTopic.create({ data: { enrollmentId: realE.id, clientId: realClient.id, monthId: realM.id, title: "Harper's topic", source: "staff", status: "SELECTED" }, select: { id: true } });
    await prisma.contentTopicSelection.create({ data: { topicId: realT.id, monthId: realM.id, enrollmentId: realE.id, clientId: realClient.id, status: "SELECTED", source: "client" } });
    await prisma.contentInterview.create({ data: { enrollmentId: realE.id, clientId: realClient.id, monthId: realM.id, topicId: realT.id, status: "SUBMITTED", submittedAt: et(10, 5, 9), sufficiencyJson: JSON.stringify({ sufficient: true, missing: [] }) } });
    const realP = await prisma.project.create({ data: { clientId: realClient.id, title: "Harper — October", status: "SCHEDULED", contentMonthId: realM.id, packageName: "Video Starter", shootDate: et(10, 8, 14) } });
    await prisma.appointment.create({ data: { projectId: realP.id, aryeoId: "b2-appt-harper-1", startAt: et(10, 8, 14), endAt: et(10, 8, 16), durationMin: 120, status: "SCHEDULED", title: "Content session 1" } });
    const realCall = await prisma.programCallRecord.create({ data: { enrollmentId: realE.id, clientId: realClient.id, callType: "MONTHLY_STRATEGY", monthId: realM.id, status: "SCHEDULED", matchState: "MATCHED", scheduledStart: et(10, 7, 14, 30), scheduledEnd: et(10, 7, 15), transcriptState: "NONE" } });
    await pm.recalcProgramMonth(realM.id);
    const bufferTasks = (status?: string) => prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: `program-call-buffer:${realM.id}` }, ...(status ? { status } : {}) }, select: { dedupeKey: true, status: true, assignedKey: true, title: true, description: true }, orderBy: { createdAt: "asc" } });
    const task = (await bufferTasks())[0] ?? null;
    const apptAfter = await prisma.appointment.findFirst({ where: { projectId: realP.id }, select: { startAt: true, status: true } });
    c.ok("recalcProgramMonth raises ONE desk task for Kyle; the appointment is not moved", task?.status === "OPEN" && task.assignedKey === "kyle" && apptAfter?.startAt?.getTime() === et(10, 8, 14).getTime() && apptAfter.status === "SCHEDULED", task?.title);
    await pm.recalcProgramMonth(realM.id);
    c.ok("a second recalculation does not add another", (await prisma.smartTask.count({ where: { dedupeKey: { startsWith: "program-call-buffer:" } } })) === 1);
    await prisma.programCallRecord.update({ where: { id: realCall.id }, data: { status: "CANCELLED" } });
    await pm.recalcProgramMonth(realM.id);
    c.ok("the call cancelled → the task closes itself", (await bufferTasks()).length === 1 && (await bufferTasks())[0].status === "COMPLETED");
    // Batch-2 review: ONE key per month could never be raised twice — the
    // closed row swallowed every later conflict (reopenIfClosed: false).
    const oldPmSrc = show("src/lib/programMonths.ts");
    c.ok("OLD (f2555f7): no call-buffer desk task existed at all", !/program-call-buffer/.test(oldPmSrc));
    await prisma.programCallRecord.create({ data: { enrollmentId: realE.id, clientId: realClient.id, callType: "MONTHLY_STRATEGY", monthId: realM.id, status: "SCHEDULED", matchState: "MATCHED", scheduledStart: et(10, 7, 11), scheduledEnd: et(10, 7, 11, 30), transcriptState: "NONE" } });
    await pm.recalcProgramMonth(realM.id);
    const openNow = await bufferTasks("OPEN");
    c.ok("a SECOND call booked inside the buffer raises a new task for Kyle (the first stays closed)", openNow.length === 1 && openNow[0].assignedKey === "kyle" && /ends Wed, Oct 7, 11:30/.test(openNow[0].description ?? "") && (await bufferTasks("COMPLETED")).length === 1, openNow.map((t) => t.dedupeKey).join(","));
    await prisma.smartTask.updateMany({ where: { dedupeKey: openNow[0]?.dedupeKey ?? "-" }, data: { status: "COMPLETED", completedAt: NOW } });
    await pm.recalcProgramMonth(realM.id);
    c.ok("…and a task a PERSON closed stays closed while that same conflict stands", (await bufferTasks("OPEN")).length === 0 && (await bufferTasks()).length === 2);
    const Y = await buildContentMonth(prisma as never, { name: "Hal Buffer TEST", package: "Starter", videosPerMonth: 1, project: { shootDate: et(10, 8, 14) }, appointments: [{ startAt: et(10, 8, 14) }], topics: [{ title: "Only topic", selection: "SELECTED" }] });
    await prisma.contentMonth.update({ where: { id: Y.monthId }, data: { planningMode: "WRITTEN" } });
    await interview(Y, Y.topicIds[0], "SUBMITTED", et(10, 5, 9));
    await prisma.programCallRecord.create({ data: { enrollmentId: Y.enrollmentId, clientId: Y.clientId, callType: "MONTHLY_STRATEGY", monthId: Y.monthId, status: "SCHEDULED", matchState: "MATCHED", scheduledStart: et(10, 7, 14, 30), scheduledEnd: et(10, 7, 15), transcriptState: "NONE" } });
    const yR = await pm.recalcProgramMonth(Y.monthId);
    c.ok("a TEST client gets the exception but never a desk task", (yR?.after.exceptions.length ?? 0) === 1 && (await prisma.smartTask.count({ where: { dedupeKey: { startsWith: `program-call-buffer:${Y.monthId}` } } })) === 0);

    // =======================================================================
    c.head("10 · Your Month: exactly one current step");
    // =======================================================================
    const mpOf = (facts: TopicPlanFacts[], route: "CALL" | "WRITTEN" | "UNDECIDED", call: "NONE" | "BOOKED" | "HELD", owed = 2) => ps.monthPlanning(facts, { route, call, videosOwed: owed });
    const open = { locked: false, reason: "", earliestISO: et(10, 9, 8).toISOString(), sessionsRequired: 1, sessionsMissing: 1, pendingRequest: false, capacityRemaining: 1 };
    const stepsFor = (o: { route: "CALL" | "WRITTEN" | "UNDECIDED"; call?: "NONE" | "BOOKED" | "HELD"; facts: TopicPlanFacts[]; schedule?: typeof open | null; deferred?: boolean; callMode?: string }) => ym.yourMonthSteps({
      monthLabel: "October",
      planning: { callMode: o.callMode ?? "OPTIONAL_WRITTEN", planningMode: o.route, callStatus: o.call === "BOOKED" ? "SCHEDULED" : o.call === "HELD" ? "COMPLETED" : "NOT_SCHEDULED", callAtISO: o.call === "BOOKED" ? et(10, 12, 13).toISOString() : null, noCallEligible: true, chosenAtISO: null, deferredAtISO: o.deferred ? NOW.toISOString() : null },
      month: mpOf(o.facts, o.route, o.call ?? "NONE"), schedule: o.schedule === undefined ? open : o.schedule, can: { suggest: true, session: true }, readOnly: false,
      hrefs: { bank: "b", month: "m", scripts: "s", bookingUrl: "https://calendly.invalid" },
    });
    const done = (id: string, r: number) => mk(id, r, { interview: { status: "SUBMITTED", missing: 0, sufficient: true } });
    const cases: [string, ReturnType<typeof stepsFor>, string, [string, string]?][] = [
      ["nothing chosen → the route prompt", stepsFor({ route: "UNDECIDED", facts: [], schedule: { ...open, locked: true, reason: "x" } }), "route"],
      ["written, 1 of 2 answered → answers", stepsFor({ route: "WRITTEN", facts: [done("A", 1), mk("B", 2)], schedule: { ...open, locked: true, reason: "Send us your planning answers first" } }), "answers"],
      ["call booked in the future → filming current, the call waiting", stepsFor({ route: "CALL", call: "BOOKED", facts: [mk("A", 1), mk("B", 2)] }), "filming", ["call", "waiting"]],
      ["Schedule later, nothing else waiting → filming stays the current step", stepsFor({ route: "WRITTEN", facts: [done("A", 1), done("B", 2)], deferred: true }), "filming"],
      ["Schedule later + a script released → scripts current, filming still outstanding", stepsFor({ route: "WRITTEN", facts: [mk("A", 1, { script: hub({ released: true, decidable: true }) }), done("B", 2)], deferred: true }), "scripts", ["filming", "todo"]],
      ["filming booked, a script released → scripts", stepsFor({ route: "WRITTEN", facts: [mk("A", 1, { script: hub({ released: true, decidable: true }) }), done("B", 2)], schedule: { ...open, sessionsMissing: 0 } }), "scripts"],
      ["call held with one gap → the call step asks the one question", stepsFor({ route: "CALL", call: "HELD", facts: [mk("A", 1, { callExcerpts: 3 }), mk("B", 2, { interview: { status: "NEEDS_FOLLOWUP", missing: 1, sufficient: false } })], schedule: { ...open, sessionsMissing: 0 } }), "call"],
    ];
    for (const [label, steps, want, also] of cases) {
      const currents = steps.filter((x) => x.state === "current");
      const extra = also ? steps.find((x) => x.key === also[0])?.state === also[1] : true;
      c.ok(label, currents.length === 1 && currents[0].key === want && extra, steps.map((x) => `${x.key}:${x.state}`).join(" "));
    }
    const heldGap = cases[6][1].find((x) => x.key === "call");
    c.ok("…its button is 'Answer one more question'", heldGap?.cta?.label === words.CTA_WORDS.ANSWER_MORE && heldGap.title === "We need one more answer", `${heldGap?.cta?.label} / ${heldGap?.title}`);

    // =======================================================================
    c.head("11 · plain labels (§11)");
    // =======================================================================
    const tb = code(read("src/components/portal/TopicBank.tsx"));
    const sac = code(read("src/components/portal/ScriptApprovalCard.tsx"));
    c.ok("OLD: 'Select for {Mon}', 'Swap for another topic', 'Read & approve the script', 'I'll film this' / 'Change something'", /Select for \{shortMonth/.test(show("src/components/portal/TopicBank.tsx")) && /Read &amp; approve the script/.test(show("src/components/portal/TopicBank.tsx")) && /I&rsquo;ll film this/.test(show("src/components/portal/ScriptApprovalCard.tsx")));
    c.ok("NEW: none of those remain in the rendered code", !/Select for|Use for \{|Swap for another topic|Read &amp; approve/.test(tb) && !/I&rsquo;ll film this|Change something/.test(sac));
    c.ok("…the buttons read CTA_WORDS: Choose this topic / Choose another topic / Review script / Approve script / Request changes", /CTA_WORDS\.CHOOSE/.test(tb) && /CTA_WORDS\.SWAP/.test(tb) && /CTA_WORDS\.REVIEW/.test(tb) && /CTA_WORDS\.APPROVE/.test(sac) && /CTA_WORDS\.CHANGES/.test(sac));
    const cta = words.CTA_WORDS;
    c.ok("the words are §11's", cta.CHOOSE === "Choose this topic" && cta.SWAP === "Choose another topic" && cta.ANSWER === "Answer questions" && cta.REVIEW === "Review script" && cta.APPROVE === "Approve script" && cta.CHANGES === "Request changes" && cta.BOOK === "Book filming" && cta.LATER === "Schedule later");
    const nav = (await import("@/lib/portalNav")).portalNav({ publishedResources: 0 });
    c.ok("the nav says 'Your Month' (the destination key is still plan)", nav.primary.find((i) => i.dest === "plan")?.label === "Your Month");
    const groupT = tp.groups.find((g) => !g.pillarId)?.pillarName;
    const staffBank = await topicsLib.topicBankByPillar(T.enrollmentId);
    c.ok("the pillar-less client group is 'More ideas' (staff topics) — staff keep their own heading", groupT === "More ideas" && staffBank.groups.some((g) => g.pillarName === "Not yet linked to a pillar"), String(groupT));
    await prisma.contentTopic.create({ data: { enrollmentId: Q.enrollmentId, clientId: Q.clientId, title: "My own idea", source: "client", status: "IDEA", clientUserId: Q.clientUserId } });
    await prisma.contentTopic.updateMany({ where: { enrollmentId: Q.enrollmentId, source: { not: "client" } }, data: { source: "client" } });
    const tpQ = await portal.portalTopics((await viewerOf(Q.portalToken)).enrollment);
    c.ok("…and 'Your ideas' when every topic in it is the client's own", tpQ.groups.find((g) => !g.pillarId)?.pillarName === "Your ideas");

    // =======================================================================
    c.head("12 · batch-2 review fixes");
    // =======================================================================
    {
      // (a) WRITTEN route + a booked call to talk things through, and NO answers.
      // All four of the Accelerator's topics chosen: since batch 3 (§3, A18) a
      // written session opens only once EVERY topic is chosen and answered, so
      // a 2-of-4 fixture would stay UNDER_PLANNED and never reach the buffer.
      const WB = await buildContentMonth(prisma as never, { name: "Ivy Written Call TEST", package: "Accelerator", project: false, topics: ["A", "B", "C", "D"].map((x) => ({ title: `Written ${x}`, selection: "SELECTED" as const })) });
      await prisma.contentEnrollment.update({ where: { id: WB.enrollmentId }, data: { callMode: "OPTIONAL_WRITTEN" } });
      await prisma.contentMonth.update({ where: { id: WB.monthId }, data: { planningMode: "WRITTEN" } });
      const baseSrc = show("src/lib/portal.ts");
      c.ok("OLD (f2555f7): the booked-call branch came BEFORE the written route's answers lock", baseSrc.indexOf('d.strategyCallStatus === "SCHEDULED"') > 0 && baseSrc.indexOf('d.strategyCallStatus === "SCHEDULED"') < baseSrc.indexOf('if (d.planningMode === "WRITTEN") return closed(LOCK_ANSWERS'));
      await prisma.programCallRecord.create({ data: { enrollmentId: WB.enrollmentId, clientId: WB.clientId, callType: "MONTHLY_STRATEGY", monthId: WB.monthId, status: "SCHEDULED", matchState: "MATCHED", scheduledStart: et(10, 9, 13), scheduledEnd: et(10, 9, 13, 30), transcriptState: "NONE" } });
      const gWB = await portal.sessionGate(WB.enrollmentId, WB.monthId, { now: NOW });
      c.ok("NEW: written route, call booked, no answers → filming stays LOCKED on the answers (§3)", gWB.locked && /planning answers/.test(gWB.reason) && gWB.planningMode === "WRITTEN", `${gWB.locked} ${gWB.reason}`);
      const vWB = await viewerOf(WB.portalToken);
      const reqWB = await actions.portalRequestSession({ token: WB.portalToken }, { monthId: WB.monthId, slotISO: et(10, 20, 10).toISOString(), location: "123 Main St, Doylestown, PA 18901" });
      c.ok("…and a filming request is refused BY THE GATE (nothing written)", !reqWB.ok && /planning answers/.test(reqWB.message ?? "") && (await prisma.programSessionRequest.count({ where: { monthId: WB.monthId } })) === 0, reqWB.message);
      const remWB = (await reminders.previewReminders(WB.monthId, { now: NOW })).lanes.find((l) => l.lane === "PRIMARY")?.candidate;
      c.ok("…the answers reminder still runs (COMPLETE_ANSWERS, not suppressed 'booked')", remWB?.action === "COMPLETE_ANSWERS" && remWB.suppressionReason !== "booked", `${remWB?.action} ${remWB?.decision} ${remWB?.suppressionReason}`);
      c.ok("…and Your Month's schedule reads the same lock", (await portal.portalScheduleMonths(vWB.enrollment)).find((m) => m.monthId === WB.monthId)?.locked === true);
      // Answers in: open, but never inside the call's buffer (§6.4).
      for (const [i, id] of WB.topicIds.entries()) await interview(WB, id, "SUBMITTED", et(10, 5, 9 + i));
      const gWB2 = await portal.sessionGate(WB.enrollmentId, WB.monthId, { now: NOW });
      const bufWB = pm.earliestFilmingStart(et(10, 9, 13, 30), { windowHours: (await pm.recalcProgramMonth(WB.monthId, { dryRun: true, now: NOW }))!.after.windowHours, windowWaived: false });
      c.ok("answers in → open, earliest = the call's end + the window (the buffer), not the submission's", !gWB2.locked && gWB2.earliest.getTime() === bufWB.getTime(), `${gWB2.locked} ${gWB2.preparation?.lock ?? ""} ${gWB2.earliest.toISOString()}`);

      // (b) CALL route, call held but its transcript not read yet.
      const CH = await buildContentMonth(prisma as never, { name: "Dana Callroute TEST", package: "Starter", project: false, topics: [{ title: "Held one", selection: "SELECTED" }, { title: "Held two", selection: "SELECTED" }] });
      const chCall = await prisma.programCallRecord.create({ data: { enrollmentId: CH.enrollmentId, clientId: CH.clientId, callType: "MONTHLY_STRATEGY", monthId: CH.monthId, status: "COMPLETED", matchState: "MATCHED", scheduledStart: et(10, 5, 13), scheduledEnd: et(10, 5, 13, 30), transcriptState: "AWAITING" } });
      const vCH = await viewerOf(CH.portalToken);
      const stepsCH = async () => (await portal.portalTopics(vCH.enrollment)).groups.flatMap((g) => g.topics).filter((t) => CH.topicIds.includes(t.id)).map((t) => t.plan?.step ?? null);
      const planCH = async () => (await (await import("@/lib/planningFacts")).planningForMonth(CH.monthId, { now: NOW }))!;
      const p1 = await planCH();
      const oldHomeTab = show("src/components/portal/tabs/HomeTab.tsx");
      c.ok("OLD (f2555f7's Home): the answers prompt was written-route only", /planningMode === "WRITTEN"/.test(oldHomeTab));
      c.ok("NEW: held call, transcript AWAITING → both topics WRITING, nothing owed, no questionnaire pushed", p1.route === "CALL" && p1.call === "HELD" && !p1.callRead && JSON.stringify(await stepsCH()) === JSON.stringify(["WRITING", "WRITING"]) && p1.planning.answersOwed === 0 && p1.planning.headline.text === "We're writing your scripts", `${JSON.stringify(await stepsCH())} ${p1.planning.headline.text}`);
      c.ok("…Home's answers list (planModel.toAnswer, what the v1 Home reads) is empty", home.planModel(await portal.portalTopics(vCH.enrollment), MONTH).toAnswer.length === 0);
      await prisma.programCallRecord.update({ where: { id: chCall.id }, data: { transcriptState: "ANALYZED" } });
      const p2 = await planCH();
      c.ok("the transcript READ and neither topic in it → a genuine gap: NEEDS_MORE, 2 owed", p2.callRead && JSON.stringify(await stepsCH()) === JSON.stringify(["NEEDS_MORE", "NEEDS_MORE"]) && p2.planning.answersOwed === 2, JSON.stringify(await stepsCH()));
      await prisma.programCallRecord.update({ where: { id: chCall.id }, data: { transcriptState: "AWAITING", status: "CANCELLED" } });
      await prisma.contentMonth.update({ where: { id: CH.monthId }, data: { strategyCallStatus: "COMPLETED", transcriptText: "Jordan: pasted notes from the call." } });
      const p3 = await planCH();
      c.ok("a month holding only a PASTED transcript is not 'read' either → WRITING", p3.call === "HELD" && !p3.callRead && JSON.stringify(await stepsCH()) === JSON.stringify(["WRITING", "WRITING"]), `${p3.call} ${JSON.stringify(await stepsCH())}`);

      // (c) remove A, pick C, re-pick A: the re-pick joins the queue NOW.
      const repick = async (lib: typeof topicsLib, label: string) => {
        const f = await buildContentMonth(prisma as never, { name: `Rae Repick ${label} TEST`, package: "Starter", project: false, topics: [{ title: "Pick A", selection: null }, { title: "Pick B", selection: null }, { title: "Pick C", selection: null }] });
        const [A, B, C] = f.topicIds;
        const who = { kind: "CLIENT" as const, clientUserId: f.clientUserId! };
        const pause = () => new Promise((r) => setTimeout(r, 15));
        await lib.selectTopicForMonth(A, f.monthId, { source: "client", actor: who }); await pause();
        await lib.selectTopicForMonth(B, f.monthId, { source: "client", actor: who }); await pause();
        await lib.deselectTopic(A, f.monthId, who); await pause();
        await lib.selectTopicForMonth(C, f.monthId, { source: "client", actor: who }); await pause();
        const again = await lib.selectTopicForMonth(A, f.monthId, { source: "client", actor: who });
        const a = await (await import("@/lib/planningFacts")).monthAllowances([f.monthId]);
        const slots = a.get(f.monthId)!.slots;
        return { again, A: slots.get(A), B: slots.get(B), C: slots.get(C) };
      };
      const oldTopics = await loadBase<typeof import("@/lib/contentTopics")>("src/lib/contentTopics.ts");
      const oldR = await repick(oldTopics as typeof topicsLib, "Old");
      c.ok("OLD (f2555f7): the revived row kept its first pick's time — A (added as an extra) took C's slot", oldR.again.overflow === true && oldR.A === "IN" && oldR.C === "EXTRA", JSON.stringify(oldR));
      const newR = await repick(topicsLib, "New");
      c.ok("NEW: A is the extra it was told it was; B and C keep their slots", newR.again.overflow === true && newR.A === "EXTRA" && newR.B === "IN" && newR.C === "IN", JSON.stringify(newR));

      // (d) the overview's answers count is the portal's.
      const AO = await buildContentMonth(prisma as never, { name: "Ann Answers TEST", package: "Starter", project: false, topics: [{ title: "Owed one", selection: "SELECTED" }, { title: "Filmed one", selection: "SELECTED" }, { title: "Extra one", selection: "SELECTED" }] });
      await prisma.contentEnrollment.update({ where: { id: AO.enrollmentId }, data: { callMode: "OPTIONAL_WRITTEN" } });
      await prisma.contentMonth.update({ where: { id: AO.monthId }, data: { planningMode: "WRITTEN" } });
      await prisma.contentTopic.update({ where: { id: AO.topicIds[1] }, data: { status: "FILMED" } });
      for (const id of AO.topicIds) await interview(AO, id, "IN_PROGRESS", null, null);
      const ovMod = await import("@/lib/programOverview");
      const oldOvMod = await loadBase<typeof import("@/lib/programOverview")>("src/lib/programOverview.ts");
      const aoRow = async (m: typeof ovMod) => (await m.programOverview({ monthKey: MONTH, enrollmentIds: [AO.enrollmentId], now: NOW })).rows.find((r) => r.monthId === AO.monthId) ?? null;
      const plAO = await portal.portalPlanning((await viewerOf(AO.portalToken)).enrollment);
      const oldAO = await aoRow(oldOvMod as typeof ovMod);
      const newAO = await aoRow(ovMod);
      c.ok("OLD overview: every open interview row counted (extra and filmed too) — 3", oldAO?.planning.answersOutstanding === 3, String(oldAO?.planning.answersOutstanding));
      c.ok("NEW overview = the portal: 1 topic owes answers", plAO?.interviewsOpen === 1 && newAO?.planning.answersOutstanding === 1 && newAO.work.answersOutstanding === 1 && /^1 topic still waiting/.test(newAO.nextAction.text), `${plAO?.interviewsOpen} / ${newAO?.planning.answersOutstanding} / ${newAO?.nextAction.text}`);
    }

    // =======================================================================
    c.head("isolation");
    c.ok("no outbound call left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.ok("no email or text was queued", (await prisma.outboxMessage.count()) === 0);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
