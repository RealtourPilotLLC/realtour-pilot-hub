// ---------------------------------------------------------------------------
// DRILL: unified handoff batch 3 — THE PREPARATION GATES (W01, A18, A19, A20,
// A21, A24, §6.6 legacy call stamp, §6.6 24-hour contact), Sep 25 2026.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/b3-gates.ts
//
// OLD behaviour first wherever it can be observed: programMonths.ts and
// monthProgress.ts at 810b29f (pinned — the tree batch 3 starts from, never
// HEAD) are loaded for real, their `@/` imports pointed at this tree, and run
// on the same inputs.
//
//    1. The clock at 72 weekday hours: §3's own examples, weekends, the
//       Friday 2 PM → Wednesday 2 PM rule across the Nov 1 2026 DST change,
//       spring forward, and a UTC-Saturday / ET-Friday evening.
//    2. W01: month column → enrollment override → 72; the legacy day key read
//       ×24; the owner override used to be a dead control; the Settings label.
//    3. A18 written route: a session opens only when ALL its topics are chosen
//       and their answers SUBMITTED; server refuses earliest − 1 min on both
//       the request and the reschedule path; the request snapshots its gate;
//       Kyle's desk task names the earliest start.
//    4. A19 call route: opens the moment the call is BOOKED, measured from its
//       scheduled END — before, during and after the call; a moved call moves
//       it; a cancelled one shuts it; no end → start, said so.
//    5. A20 one reading: the same instant in the portal gate, the schedule
//       card, the reminder, the staff Sessions view, the overview and the
//       desk text; nothing else calls addWeekdayHoursET.
//    6. §6.6 legacy call stamp: a stamped call with no record opens from its
//       start, says so, and raises ONE "confirm this call's end" task for Kyle
//       that closes itself when the record lands. (Batch-3 review) A stored
//       COMPLETED whose own records are all dead is not a legacy stamp: shut,
//       'book your call'; a pasted transcript still is.
//    7. A24 Pro: two sessions, each held to its own material; one live ask
//       per session; the desk says "1 of 2"; cards carry their index.
//       (Batch-3 review) A session held with no index — a pre-batch ask, a
//       hand booking — is taken too (server and picker); the reminder asks
//       for session 2's topics and answers while its own gate is shut.
//    8. A21 Schedule later per session, the reminder lane unchanged; a route
//       switch twice creates nothing.
//    9. §6.6 inside 24 hours: Kyle's number, nothing written (ALREADY_FIXED —
//       confirmed at HEAD).
//   10. The words: terms, route cards, schedule tab, guides.
//
// Not asserted here (owned by other drills): the 48 → 72 rule change raising
// no reassessment (b3-reassess.ts §B), exact-address/travel slots
// (session-booking-adapter.ts), Calendly booking (b3-calendly.ts).
//
// ISOLATION: PGlite on 127.0.0.1:5661 (the harness). Production is never
// opened; every non-loopback call is fenced and counted; nothing is sent.
// THE CLOCK IS PINNED to Thu Oct 29 2026 10:00 ET — three days before the
// Nov 1 DST change, so the weekday-hour window crosses a weekend AND the
// clock change on the same Friday.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import type { PortalViewer } from "@/lib/portal";
import type { DeriveInput, MonthCallRecordInput, TopicMaterialInput } from "@/lib/programMonths";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5661);
const BASE = "810b29f"; // pinned: the tree batch 3 starts from, never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const ET_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
/** An ET wall clock, DST-correct (tries EDT then EST and keeps the one that reads back). */
function et(y: number, mo: number, d: number, h: number, mi = 0): Date {
  for (const off of [4, 5]) {
    const t = new RealDate(RealDate.UTC(y, mo - 1, d, h + off, mi));
    const p = Object.fromEntries(ET_PARTS.formatToParts(t).map((x) => [x.type, x.value]));
    if (+p.year === y && +p.month === mo && +p.day === d && +p.hour === h && +p.minute === mi) return t;
  }
  throw new Error(`no such ET wall time ${y}-${mo}-${d} ${h}:${mi}`);
}
/** "Wed, Nov 4, 2:00 PM" — how every expectation below is written. */
const wall = (d: Date | null | undefined) => (d ? d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "null");
const NOW0 = et(2026, 10, 29, 10); // Thu Oct 29 2026, 10:00 AM EDT
// Pinned once: every "now" that moves below is passed explicitly (opts.now).
const offset = NOW0.getTime() - RealDate.now();
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
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "b3-gates-base-"));
fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseDir, "node_modules"));
const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
async function loadBase<T>(rel: string): Promise<T> {
  const file = path.join(baseDir, rel.replace(/\//g, "__"));
  fs.writeFileSync(file, show(rel).replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`));
  return (await import(file)) as T;
}
const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
/** Source with comments removed — a word in a comment is not a word on screen. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(rel));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

// ---- pure inputs -----------------------------------------------------------------
type MonthIn = DeriveInput["month"];
const monthIn = (o: Partial<MonthIn> = {}): MonthIn => ({
  strategyCallStatus: "NOT_SCHEDULED", strategyCallAt: null, transcriptText: null, planningMode: "WRITTEN", preparationStatus: null,
  preparationCompletedAt: null, preparationWindowDays: null, preparationExceptionAt: null, preparationExceptionReason: null, filmingReadyAt: null, historical: false, ...o,
});
const topicIn = (id: string, i: number, iv: { status: string; at: Date | null; sufficient?: boolean | null } | null): TopicMaterialInput => ({
  topicId: id, status: "SELECTED", title: id, createdAt: new RealDate(RealDate.UTC(2026, 8, 1, i)), scriptApproved: false, scriptApprovedAt: null,
  interviewStatus: iv?.status ?? null, interviewSubmittedAt: iv?.at ?? null, interviewSufficient: iv?.sufficient ?? null,
});
const rec = (id: string, start: Date | null, end: Date | null, status = "SCHEDULED"): MonthCallRecordInput =>
  ({ id, callType: "MONTHLY_STRATEGY", status, matchState: "MATCHED", scheduledStart: start, scheduledEnd: end, transcriptState: "NONE" });
const writtenInput = (o: { now: Date; topics: TopicMaterialInput[]; videos: number; sessions?: number; records?: MonthCallRecordInput[]; month?: Partial<MonthIn>; windowHours?: number | null }): DeriveInput => ({
  now: o.now, month: monthIn(o.month), enrollment: { callMode: "OPTIONAL_WRITTEN", strategyCallRequired: true, noCallEligible: true, preparationWindowHours: o.windowHours ?? null },
  records: o.records ?? [], scripts: [],
  interviews: o.topics.filter((t) => t.interviewStatus).map((t) => ({ topicId: t.topicId, status: t.interviewStatus!, submittedAt: t.interviewSubmittedAt })),
  topics: o.topics, plan: { videosPerMonth: o.videos, sessionsPerMonth: o.sessions ?? 1 },
});
const callInput = (o: { now: Date; records: MonthCallRecordInput[]; month?: Partial<MonthIn> }): DeriveInput => ({
  now: o.now, month: monthIn({ planningMode: "CALL", strategyCallStatus: "SCHEDULED", ...o.month }), enrollment: { callMode: "REQUIRED", strategyCallRequired: true, noCallEligible: false },
  records: o.records, scripts: [], interviews: [], topics: [topicIn("A", 1, null), topicIn("B", 2, null)], plan: { videosPerMonth: 2, sessionsPerMonth: 1 },
});
const SUB = (at: Date) => ({ status: "SUBMITTED", at, sufficient: true });

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { PROGRAM_DESK_TASKS_FOR_TEST: "1" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const pm = await import("@/lib/programMonths");
  const portal = await import("@/lib/portal");
  const home = await import("@/lib/portalHome");
  const mp = await import("@/lib/monthProgress");
  const reminders = await import("@/lib/programReminders");
  const templates = await import("@/lib/reminderTemplates");
  const changes = await import("@/lib/enrollmentChanges");
  const actions = await import("@/app/portal/actions");
  const ws = await import("@/app/content/[id]/workspaceData");
  const ov = await import("@/lib/programOverview");
  const { PortalPage } = await import("@/components/portal/PortalPage");
  const oldPM = await loadBase<typeof import("@/lib/programMonths")>("src/lib/programMonths.ts");
  const oldMP = await loadBase<typeof import("@/lib/monthProgress")>("src/lib/monthProgress.ts");
  const MONTH = "2026-10";

  const viewerOf = async (token: string | null): Promise<PortalViewer> => {
    const r = await portal.resolvePortalViewer({ token: token ?? "" });
    if (!r.ok) throw new Error(`viewer did not resolve: ${r.reason}`);
    return r.viewer;
  };
  const ownerOf = (v: PortalViewer, f: { clientUserId: string | null; membershipId: string | null }): PortalViewer =>
    ({ ...v, actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: "owner@example.com", name: "Owner", membershipId: f.membershipId!, membershipRole: "OWNER" }, via: "LOGIN" });
  const interview = (f: ContentMonthFixture, topicId: string, status: string, submittedAt: Date | null) =>
    prisma.contentInterview.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, topicId, status, submittedAt, sufficiencyJson: JSON.stringify({ sufficient: true, missing: [] }) } });
  const callRecord = (f: ContentMonthFixture, start: Date, end: Date | null, status = "SCHEDULED", monthId: string | null = f.monthId) =>
    prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, callType: "MONTHLY_STRATEGY", monthId, status, matchState: "MATCHED", scheduledStart: start, scheduledEnd: end, transcriptState: "NONE" } });
  const planRow = (f: ContentMonthFixture, sessionIndex: number, mapped = true) =>
    prisma.programSessionPlan.create({
      data: {
        enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, sessionIndex,
        streetNumber: "123", streetName: "Main St", city: "Doylestown", stateCode: "PA", postalCode: "18901",
        latitude: mapped ? 40.3101 : null, longitude: mapped ? -75.1299 : null, geocodeSource: mapped ? "drill" : null,
        addressValidatedAt: new Date(), addressVersion: 1, lastStep: "ADDRESS",
      },
    });
  const deskTask = (requestId: string) => prisma.smartTask.findUnique({ where: { dedupeKey: `content-session-request-${requestId}` }, select: { title: true, description: true, status: true, assignedKey: true } });
  const homeActionsOf = async (v: PortalViewer) => {
    const tree = await PortalPage({ viewer: v, path: "/portal/[token]", query: { tab: "home" } });
    const a = find(tree, "HomeV2")[0]?.props.actions as { primary: { kind: string; detail: string | null } | null; more: { kind: string; detail: string | null }[] } | undefined;
    return a ? [a.primary, ...a.more].filter((x): x is NonNullable<typeof x> => !!x) : [];
  };
  const primaryLane = async (monthId: string, now: Date) => (await reminders.previewReminders(monthId, { now })).lanes.find((l) => l.lane === "PRIMARY")!;

  try {
    // =======================================================================
    c.head("1 · the clock: 72 weekday hours, ET (pure; OLD first)");
    // =======================================================================
    c.ok("OLD (810b29f): the window was 48 weekday hours — Fri 2 PM → Tue 2 PM", (oldPM.DEFAULT_PREPARATION_WINDOW_HOURS as number) === 48 && wall(oldPM.addWeekdayHoursET(et(2026, 9, 25, 14), oldPM.DEFAULT_PREPARATION_WINDOW_HOURS)) === "Tue, Sep 29, 2:00 PM", String(oldPM.DEFAULT_PREPARATION_WINDOW_HOURS));
    c.ok("NEW: the window is 72 weekday hours", pm.DEFAULT_PREPARATION_WINDOW_HOURS === 72);
    const W = pm.DEFAULT_PREPARATION_WINDOW_HOURS;
    const clock: [string, Date, string][] = [
      ["§3: Monday 2:30 PM → Thursday 2:30 PM", et(2026, 9, 28, 14, 30), "Thu, Oct 1, 2:30 PM"],
      ["§3: Friday 2 PM → Wednesday 2 PM", et(2026, 9, 25, 14), "Wed, Sep 30, 2:00 PM"],
      ["Friday 11 PM → Wednesday 11 PM", et(2026, 9, 25, 23), "Wed, Sep 30, 11:00 PM"],
      ["Friday 00:00 → Wednesday 00:00 (a Friday is 24 weekday hours)", et(2026, 9, 25, 0), "Wed, Sep 30, 12:00 AM"],
      ["Saturday 9 AM → Thursday 00:00 (the weekend adds nothing)", et(2026, 9, 26, 9), "Thu, Oct 1, 12:00 AM"],
      ["Friday 9 PM ET (a SATURDAY in UTC) → Wednesday 9 PM — the client's calendar, not the server's", et(2026, 9, 25, 21), "Wed, Sep 30, 9:00 PM"],
      ["DST fall back: Friday Oct 30 2 PM EDT → Wednesday Nov 4 2 PM EST", et(2026, 10, 30, 14), "Wed, Nov 4, 2:00 PM"],
      ["DST fall back: Thursday Oct 29 2 PM EDT → Tuesday Nov 3 2 PM EST", et(2026, 10, 29, 14), "Tue, Nov 3, 2:00 PM"],
      ["DST night itself: Sunday Nov 1, 1:30 AM → Thursday Nov 5 00:00", et(2026, 11, 1, 1, 30), "Thu, Nov 5, 12:00 AM"],
      ["DST spring forward: Friday Mar 6 10 AM EST → Wednesday Mar 11 10 AM EDT", et(2026, 3, 6, 10), "Wed, Mar 11, 10:00 AM"],
      ["DST spring night: Sunday Mar 8, 3 AM → Thursday Mar 12 00:00", et(2026, 3, 8, 3), "Thu, Mar 12, 12:00 AM"],
    ];
    for (const [label, from, want] of clock) {
      const got = wall(pm.addWeekdayHoursET(from, W));
      c.ok(label, got === want, got);
    }
    const mon = et(2026, 9, 28, 14, 30);
    c.ok("elapsed, not office hours: Mon 2:30 → Thu 2:30 is exactly 72 real hours (no weekend, no clock change)", pm.addWeekdayHoursET(mon, W).getTime() - mon.getTime() === 72 * 3600_000);
    c.ok("earliestFilmingStart is that clock, and a staff waiver returns the base untouched", pm.earliestFilmingStart(mon, { windowHours: W, windowWaived: false }).getTime() === pm.addWeekdayHoursET(mon, W).getTime() && pm.earliestFilmingStart(mon, { windowHours: W, windowWaived: true }).getTime() === mon.getTime());

    // =======================================================================
    c.head("2 · W01: the window's precedence, and the override that nothing read (OLD first)");
    // =======================================================================
    c.ok("no override → 72", pm.preparationWindowHours(null) === 72 && pm.preparationWindowHours(0, null) === 72);
    c.ok("the month's legacy DAY column is read ×24 (3 → 72, 2 → 48) and wins", pm.preparationWindowHours(3) === 72 && pm.preparationWindowHours(2, 96) === 48);
    c.ok("the enrollment's HOUR override comes next (96)", pm.preparationWindowHours(null, 96) === 96);
    const eo = pm.enrollmentWindowOverrideHours;
    c.ok("enrollment JSON: hours key → hours; legacy days key → ×24; hours win over days; junk → none",
      eo('{"preparationWindowHours":96}') === 96 && eo('{"preparationWindowDays":3}') === 72 && eo('{"preparationWindowHours":60,"preparationWindowDays":3}') === 60 && eo("{}") === null && eo("not json") === null && eo('{"preparationWindowHours":0}') === null && eo(null) === null);
    {
      const t = [topicIn("A", 1, SUB(mon))];
      const d96 = pm.deriveMonthState(writtenInput({ now: et(2026, 9, 28, 16), topics: t, videos: 1, windowHours: 96 }));
      c.ok("deriveMonthState honours an enrollment override of 96: Mon 2:30 PM → Fri 2:30 PM, and says why", d96.windowHours === 96 && wall(d96.earliestSessionAt) === "Fri, Oct 2, 2:30 PM" && d96.reasons.some((r) => /96 weekday hours \(owner override\)/.test(r)), wall(d96.earliestSessionAt));
      const dDays = pm.deriveMonthState(writtenInput({ now: et(2026, 9, 28, 16), topics: t, videos: 1, windowHours: 96, month: { preparationWindowDays: 2 } }));
      c.ok("…a month's own legacy 2-day window beats it (48)", dDays.windowHours === 48 && wall(dDays.earliestSessionAt) === "Wed, Sep 30, 2:30 PM", wall(dDays.earliestSessionAt));
      const dWaived = pm.deriveMonthState(writtenInput({ now: et(2026, 9, 28, 16), topics: t, videos: 1, month: { preparationExceptionAt: et(2026, 9, 28, 15), preparationExceptionReason: "Jordan: client travelling, film Tuesday" } }));
      const gW = pm.preparationGate(dWaived, 1);
      c.ok("a staff waiver: earliest = the submission itself, and the gate says it was waived", dWaived.windowWaived && gW.earliest?.getTime() === mon.getTime() && /waived/.test(gW.reason), gW.reason);
    }
    const E = await buildContentMonth(db, { name: "Eve Override TEST", package: "Starter", videosPerMonth: 1, project: false, topics: [{ title: "Override topic", selection: "SELECTED" }] });
    await prisma.contentMonth.update({ where: { id: E.monthId }, data: { planningMode: "WRITTEN" } });
    await interview(E, E.topicIds[0], "SUBMITTED", et(2026, 10, 26, 9));
    await prisma.contentEnrollment.update({ where: { id: E.enrollmentId }, data: { overridesJson: JSON.stringify({ preparationWindowDays: 5 }) } });
    const oldE = await oldPM.recalcProgramMonth(E.monthId, { dryRun: true, now: NOW0 });
    const newE = await pm.recalcProgramMonth(E.monthId, { dryRun: true, now: NOW0 });
    c.ok("OLD: an owner override of 5 days on the enrollment was IGNORED — the gate still ran 48 hours", oldE?.after.windowHours === 48, String(oldE?.after.windowHours));
    c.ok("NEW: the same row is read — 5 days = 120 weekday hours", newE?.after.windowHours === 120, String(newE?.after.windowHours));
    const refused = async (v: unknown) => { try { await changes.setOverride(E.enrollmentId, "preparationWindowHours", v, "drill"); return false; } catch { return true; } };
    c.ok("setOverride refuses nonsense hours (0, 481, 12.5, 'abc') and a days value > 20", (await refused(0)) && (await refused(481)) && (await refused(12.5)) && (await refused("abc")) && (await (async () => { try { await changes.setOverride(E.enrollmentId, "preparationWindowDays", 30, "drill"); return false; } catch { return true; } })()));
    await changes.setOverride(E.enrollmentId, "preparationWindowHours", 96, "drill");
    const e96 = await pm.recalcProgramMonth(E.monthId, { dryRun: true, now: NOW0 });
    c.ok("…accepts 96, and the hours key beats the legacy days key (96, not 120)", e96?.after.windowHours === 96 && changes.OVERRIDE_KEYS.includes("preparationWindowHours"), String(e96?.after.windowHours));
    const panel = code(read("src/components/content/SettingsPanel.tsx"));
    c.ok("OLD Settings label: 'Preparation window (business days before filming)'", /Preparation window \(business days before filming\)/.test(show("src/components/content/SettingsPanel.tsx")));
    c.ok("NEW label: 'Preparation window (weekday hours, default 72)', writing preparationWindowHours", /Preparation window \(weekday hours, default 72\)" k="preparationWindowHours"/.test(panel) && !/business days before filming/.test(panel));

    // =======================================================================
    c.head("3 · A18 — the written route opens per session, on SUBMITTED answers (OLD first)");
    // =======================================================================
    {
      const now = et(2026, 9, 28, 16);
      const two = [topicIn("A", 1, SUB(et(2026, 9, 28, 9))), topicIn("B", 2, SUB(mon))];
      const oldUnder = oldPM.deriveMonthState(writtenInput({ now, topics: two, videos: 4 }) as never);
      const newUnder = pm.deriveMonthState(writtenInput({ now, topics: two, videos: 4 }));
      c.ok("OLD: an Accelerator session with 2 of 4 topics chosen OPENED (Kyle got only a follow-up)", oldUnder.earliestSessionAt !== null && oldUnder.followUps.some((f) => f.kind === "UNDER_PLANNED_SESSION"), wall(oldUnder.earliestSessionAt));
      c.ok("NEW: it stays shut (UNDER_PLANNED) and Kyle still gets the follow-up", newUnder.earliestSessionAt === null && newUnder.sessions[0].lock === "UNDER_PLANNED" && newUnder.followUps.some((f) => f.kind === "UNDER_PLANNED_SESSION"), String(newUnder.sessions[0].lock));
      const four = [topicIn("A", 1, SUB(et(2026, 9, 28, 9))), topicIn("B", 2, SUB(et(2026, 9, 28, 11))), topicIn("C", 3, SUB(et(2026, 9, 28, 12))), topicIn("D", 4, SUB(mon))];
      const d4 = pm.deriveMonthState(writtenInput({ now, topics: four, videos: 4 }));
      const g4 = pm.preparationGate(d4, 1);
      c.ok("4 of 4 submitted → open from the LAST submission + 72 (Mon 2:30 PM → Thu 2:30 PM)", wall(g4.earliest) === "Thu, Oct 1, 2:30 PM" && !g4.locked && g4.anchor?.kind === "SUBMISSION", wall(g4.earliest));
      c.ok("…the anchor names that submission (topic D, its instant), and the reason says so in staff words", g4.anchor?.ref === `SUBMISSION:D:${mon.getTime()}` && /72 weekday hours after when the session's answers were submitted \(Mon, Sep 28, 2:30 PM ET\)/.test(g4.reason), `${g4.anchor?.ref} · ${g4.reason}`);
      const gaps = four.map((t, i) => (i === 3 ? { ...t, interviewStatus: "SUBMITTED_WITH_GAPS" } : t));
      const dGaps = pm.deriveMonthState(writtenInput({ now, topics: gaps, videos: 4 }));
      c.ok("answers sent WITH GAPS never open it (lock ANSWERS)", dGaps.earliestSessionAt === null && dGaps.sessions[0].lock === "ANSWERS");
      const reopened = four.map((t, i) => (i === 3 ? { ...t, interviewStatus: "IN_PROGRESS" } : t));
      const dRe = pm.deriveMonthState(writtenInput({ now, topics: reopened, videos: 4 }));
      c.ok("answers reopened after sending close it again (and Kyle hears)", dRe.earliestSessionAt === null && dRe.followUps.some((f) => f.kind === "ANSWERS_REOPENED"));
      const autosaved = four.map((t, i) => (i === 3 ? { ...t, interviewStatus: "IN_PROGRESS", interviewSubmittedAt: null, interviewSufficient: true } : t));
      const dAuto = pm.deriveMonthState(writtenInput({ now, topics: autosaved, videos: 4 }));
      c.ok("an AUTOSAVE that reads sufficient but was never sent does not open it", dAuto.earliestSessionAt === null);
      const dCall = pm.deriveMonthState(writtenInput({ now, topics: four, videos: 4, records: [rec("call-late", et(2026, 9, 29, 15), et(2026, 9, 29, 15, 30))] }));
      const gCall = pm.preparationGate(dCall, 1);
      c.ok("written route + a call booked AFTER the answers: earliest = max(submission, call end) + 72 = Fri 3:30 PM, anchored on the call", wall(gCall.earliest) === "Fri, Oct 2, 3:30 PM" && gCall.anchor?.kind === "CALL_END", `${wall(gCall.earliest)} ${gCall.anchor?.ref}`);
      const dCallEarly = pm.deriveMonthState(writtenInput({ now, topics: four, videos: 4, records: [rec("call-early", et(2026, 9, 28, 9), et(2026, 9, 28, 9, 30))] }));
      c.ok("…a call that ended BEFORE the answers leaves the submission as the anchor", wall(pm.preparationGate(dCallEarly, 1).earliest) === "Thu, Oct 1, 2:30 PM" && pm.preparationGate(dCallEarly, 1).anchor?.kind === "SUBMISSION");
    }
    // PGlite: the server enforces it, on both doors, and snapshots it.
    const Wm = await buildContentMonth(db, { name: "Will Written TEST", package: "Accelerator", project: false, topics: ["W1", "W2", "W3", "W4"].map((title) => ({ title, selection: "SELECTED" as const })) });
    await prisma.contentEnrollment.update({ where: { id: Wm.enrollmentId }, data: { callMode: "OPTIONAL_WRITTEN" } });
    await prisma.contentMonth.update({ where: { id: Wm.monthId }, data: { planningMode: "WRITTEN", planningChosenAt: new Date() } });
    for (const [i, id] of Wm.topicIds.slice(0, 3).entries()) await interview(Wm, id, "SUBMITTED", et(2026, 10, 29, 6 + i));
    await interview(Wm, Wm.topicIds[3], "IN_PROGRESS", null);
    const wPlan = await planRow(Wm, 1);
    const gW3 = await portal.sessionGate(Wm.enrollmentId, Wm.monthId, { now: NOW0, sessionIndex: 1 });
    c.ok("3 of 4 answers sent → the calendar stays shut, in the client's words (no em dash)", gW3.locked && /planning answers/.test(gW3.reason) && !/—/.test(gW3.reason), gW3.reason);
    const reqEarly = await actions.portalRequestSession({ token: Wm.portalToken }, { monthId: Wm.monthId, slotISO: et(2026, 11, 4, 10).toISOString(), planId: wPlan.id, addressVersion: 1, sessionIndex: 1 });
    c.ok("…and a request is refused by the gate, nothing written", !reqEarly.ok && (await prisma.programSessionRequest.count({ where: { monthId: Wm.monthId } })) === 0, reqEarly.message);
    await prisma.contentInterview.updateMany({ where: { topicId: Wm.topicIds[3] }, data: { status: "SUBMITTED", submittedAt: et(2026, 10, 29, 9) } });
    const gW = await portal.sessionGate(Wm.enrollmentId, Wm.monthId, { now: NOW0, sessionIndex: 1 });
    const wEarliest = et(2026, 11, 3, 9); // Thu Oct 29 9:00 AM EDT + 72 weekday hours = Tue Nov 3 9:00 AM EST
    c.ok("the 4th answer sent Thu 9:00 AM EDT → open NOW, earliest Tue Nov 3 9:00 AM EST (weekend + DST crossed)", !gW.locked && gW.earliest.getTime() === wEarliest.getTime() && gW.sessionIndex === 1 && gW.preparation?.anchor?.kind === "SUBMISSION", wall(gW.earliest));
    const tooSoon = await actions.portalRequestSession({ token: Wm.portalToken }, { monthId: Wm.monthId, slotISO: new Date(wEarliest.getTime() - 60_000).toISOString(), planId: wPlan.id, addressVersion: 1, sessionIndex: 1 });
    c.ok("request at earliest − 1 min: refused server-side with the first time they CAN pick (no em dash)", !tooSoon.ok && /Tuesday, November 3(,| at) 9:00 AM ET/.test(tooSoon.message) && !/—/.test(tooSoon.message) && (await prisma.programSessionRequest.count({ where: { monthId: Wm.monthId } })) === 0, tooSoon.message);
    const okReq = await actions.portalRequestSession({ token: Wm.portalToken }, { monthId: Wm.monthId, slotISO: wEarliest.toISOString(), planId: wPlan.id, addressVersion: 1, sessionIndex: 1 });
    const wRow = okReq.requestId ? await prisma.programSessionRequest.findUnique({ where: { id: okReq.requestId } }) : null;
    c.ok("request AT earliest: accepted", okReq.ok && !!wRow && wRow.slotStart?.getTime() === wEarliest.getTime(), okReq.message);
    c.ok("…the row snapshots the gate it was offered under: session 1, WRITTEN, the submission's anchor, 72 hours, the earliest",
      wRow?.sessionIndex === 1 && wRow.gateRoute === "WRITTEN" && wRow.gateAnchorRef === `SUBMISSION:${Wm.topicIds[3]}:${et(2026, 10, 29, 9).getTime()}` && wRow.gateAnchorAt?.getTime() === et(2026, 10, 29, 9).getTime() && wRow.gateWindowHours === 72 && wRow.gateEarliestAt?.getTime() === wEarliest.getTime(),
      `${wRow?.sessionIndex} ${wRow?.gateRoute} ${wRow?.gateAnchorRef} ${wRow?.gateWindowHours} ${wall(wRow?.gateEarliestAt)}`);
    const wTask = wRow ? await deskTask(wRow.id) : null;
    c.ok("Kyle's desk task names the earliest start allowed and what it is counted from", !!wTask && wTask.assignedKey === "kyle" && (wTask.description ?? "").includes("Earliest start allowed: Tue, Nov 3, 9:00 AM ET (72 weekday hours after the answers were submitted, Thu, Oct 29, 9:00 AM ET)."), (wTask?.description ?? "").split("\n").find((l) => /Earliest/.test(l)));
    const moveSoon = await actions.portalRescheduleSession({ token: Wm.portalToken }, wRow!.id, { slotISO: new Date(wEarliest.getTime() - 30 * 60_000).toISOString() });
    c.ok("reschedule to earliest − 30 min: refused on the same gate", !moveSoon.ok && /Tuesday, November 3(,| at) 9:00 AM ET/.test(moveSoon.message), moveSoon.message);
    const moveOk = await actions.portalRescheduleSession({ token: Wm.portalToken }, wRow!.id, { slotISO: et(2026, 11, 4, 10).toISOString() });
    const moved = moveOk.ok ? await prisma.programSessionRequest.findFirst({ where: { supersedesId: wRow!.id }, orderBy: { createdAt: "desc" } }) : null;
    c.ok("reschedule to Wed 10 AM: accepted; the new row keeps session 1 and snapshots the same anchor", moveOk.ok && moved?.sessionIndex === 1 && moved.gateAnchorRef === wRow!.gateAnchorRef && moved.gateWindowHours === 72, `${moveOk.message} ${moved?.sessionIndex} ${moved?.gateAnchorRef}`);
    const withdraw = moved ? await actions.portalCancelSessionRequest({ token: Wm.portalToken }, moved.id) : null;
    c.ok("(the move withdrawn again, so the month is back to one live ask)", !!withdraw?.ok, withdraw?.message);

    // =======================================================================
    c.head("4 · A19 — the call route opens when the call is BOOKED, from its scheduled END (OLD first)");
    // =======================================================================
    {
      const call = rec("rec-1", et(2026, 9, 28, 14), et(2026, 9, 28, 14, 30));
      const before = et(2026, 9, 25, 10);
      const oldD = oldPM.deriveMonthState(callInput({ now: before, records: [call] }) as never);
      c.ok("OLD derivation: a booked, future call Mon 2:00–2:30 opened NOTHING (the reminder and overview read this)", oldD.earliestSessionAt === null);
      const newD = pm.deriveMonthState(callInput({ now: before, records: [call] }));
      const g = pm.preparationGate(newD);
      c.ok("NEW: open while the call is still ahead — Thu Oct 1 2:30 PM (end + 72), never the booking click", wall(g.earliest) === "Thu, Oct 1, 2:30 PM" && g.anchor?.kind === "CALL_END" && g.anchor.ref === `CALL_END:rec-1:${et(2026, 9, 28, 14, 30).getTime()}`, `${wall(g.earliest)} ${g.anchor?.ref}`);
      const during = pm.preparationGate(pm.deriveMonthState(callInput({ now: et(2026, 9, 28, 14, 10), records: [call] })));
      const after = pm.preparationGate(pm.deriveMonthState(callInput({ now: et(2026, 9, 28, 15), records: [call] })));
      const held = pm.preparationGate(pm.deriveMonthState(callInput({ now: et(2026, 9, 28, 15), records: [{ ...call, status: "COMPLETED" }] })));
      c.ok("…the SAME instant 10 minutes into the call, after it, and once marked completed", [during, after, held].every((x) => x.earliest?.getTime() === g.earliest?.getTime() && !x.locked));
      const movedCall = pm.preparationGate(pm.deriveMonthState(callInput({ now: before, records: [{ ...call, status: "RESCHEDULED" }, rec("rec-2", et(2026, 9, 29, 10), et(2026, 9, 29, 10, 30))] })));
      c.ok("the call rebooked to Tue 10:00–10:30 moves it to Fri 10:30 AM, with a different anchor", wall(movedCall.earliest) === "Fri, Oct 2, 10:30 AM" && movedCall.anchor?.ref !== g.anchor?.ref, `${wall(movedCall.earliest)} ${movedCall.anchor?.ref}`);
      const cancelled = pm.preparationGate(pm.deriveMonthState(callInput({ now: before, records: [{ ...call, status: "CANCELLED" }] })));
      c.ok("cancelled with nothing in its place: shut, 'no strategy call is booked'", cancelled.locked && cancelled.earliest === null && cancelled.lock === "BOOK_CALL", cancelled.reason);
      const noEndD = pm.deriveMonthState(callInput({ now: before, records: [rec("rec-3", et(2026, 9, 28, 14), null)] }));
      const noEnd = pm.preparationGate(noEndD);
      c.ok("a record with no end: measured from its start (Thu 2:00 PM), marked estimated, and the reason says so", wall(noEnd.earliest) === "Thu, Oct 1, 2:00 PM" && noEnd.anchor?.estimated === true && noEndD.reasons.some((r) => /no end time on record/.test(r)), wall(noEnd.earliest));
    }
    const baseSrc = code(show("src/lib/portal.ts"));
    const headSrc = code(read("src/lib/portal.ts"));
    c.ok("OLD portal.sessionGate ran its OWN booked-call branch (a second reading of the rule)", /const callEndsAt = d\.strategyCallEndsAt \?\? d\.strategyCallAt;/.test(baseSrc) && /earliestFilmingStart\(callEndsAt/.test(baseSrc));
    c.ok("NEW: that branch is gone — the gate is preparationGate + the 24-hour floor", !/strategyCallEndsAt \?\? d\.strategyCallAt/.test(headSrc) && !/earliestFilmingStart\(/.test(headSrc) && /preparationGate/.test(headSrc));
    // PGlite: Friday call, the weekend, and the DST change in one window.
    // A staff-controlled inbox, so the preview renders the body (a TEST client
    // with an outside address is held as test_client_real_address). Nothing is sent.
    const Cm = await buildContentMonth(db, { name: "Cal Callroute TEST", package: "Accelerator", project: false, owner: { email: "drill-cal@realtourpilot.com" }, topics: [{ title: "Call topic one", selection: "SELECTED" }] });
    await prisma.contentMonth.update({ where: { id: Cm.monthId }, data: { planningMode: "CALL", planningChosenAt: new Date() } });
    const cRec = await callRecord(Cm, et(2026, 10, 30, 13, 30), et(2026, 10, 30, 14)); // Fri Oct 30, 1:30–2:00 PM EDT
    const cEarliest = et(2026, 11, 4, 14); // Wed Nov 4, 2:00 PM EST
    const gC = await portal.sessionGate(Cm.enrollmentId, Cm.monthId, { now: NOW0 });
    c.ok("booked Thursday for a Friday 1:30–2:00 PM EDT call: open NOW, earliest Wed Nov 4 2:00 PM EST", !gC.locked && gC.earliest.getTime() === cEarliest.getTime() && gC.preparation?.anchor?.ref === `CALL_END:${cRec.id}:${et(2026, 10, 30, 14).getTime()}`, wall(gC.earliest));
    const gCduring = await portal.sessionGate(Cm.enrollmentId, Cm.monthId, { now: et(2026, 10, 30, 13, 45) });
    c.ok("…15 minutes into the call the portal gate says the same", !gCduring.locked && gCduring.earliest.getTime() === cEarliest.getTime(), wall(gCduring.earliest));
    // The reminder holds itself while the Aryeo feed is dark (stale_scheduler_sync,
    // the Sep 8 rule) — a fresh sync on file, as production has every hour.
    await prisma.connection.upsert({ where: { provider: "aryeo" }, create: { provider: "aryeo", status: "CONNECTED", lastSyncedAt: NOW0 }, update: { status: "CONNECTED", lastSyncedAt: NOW0, lastError: null } });
    const remC = await primaryLane(Cm.monthId, NOW0);
    c.ok("OLD reminder evaluator: a booked call ENDED the evaluation ('booked — nothing to remind')", /if \(planningSuppression === "booked"\) return sup\("booked"/.test(show("src/lib/programReminders.ts")));
    c.ok("NEW: the reminder asks for filming now (BOOK_SESSION, not suppressed 'booked')", remC.candidate.action === "BOOK_SESSION" && remC.candidate.suppressionReason !== "booked", `${remC.candidate.action} ${remC.candidate.decision} ${remC.candidate.suppressionReason}`);
    c.ok("…quoting the gate's own instant, with the time of day, and saying the call is still ahead (template v2, no em dash)",
      remC.candidate.state.earliestSessionAt === cEarliest.toISOString() && remC.candidate.templateKey === "reminder.book_session.v2" &&
      /booked for Friday, October 30 at 1:30 PM ET/.test(remC.body ?? "") && /The earliest we can film is Wednesday, November 4 at 2:00 PM ET/.test(remC.body ?? "") && !/—/.test(remC.body ?? ""),
      `${remC.candidate.decision} ${remC.candidate.suppressionReason} ${remC.candidate.templateKey} ${remC.body}`);
    c.ok("book_session.v1 is retired to v2 (its 'your content is planned' is false while the call is ahead)", templates.sendableTemplateId("reminder.book_session.v1") === "reminder.book_session.v2");

    // =======================================================================
    c.head("5 · A20 — one reading everywhere");
    // =======================================================================
    const vC = await viewerOf(Cm.portalToken);
    const schC = (await portal.portalScheduleMonths(vC.enrollment)).find((m) => m.monthId === Cm.monthId);
    const staffC = await ws.loadSessionGates({ id: Cm.monthId }, { now: NOW0 });
    const ovC = (await ov.programOverview({ monthKey: MONTH, enrollmentIds: [Cm.enrollmentId], now: NOW0 })).rows.find((r) => r.monthId === Cm.monthId);
    c.ok("call route — portal gate = schedule card = reminder = staff Sessions view = overview", [
      gC.earliest.toISOString(), schC?.earliestISO, remC.candidate.state.earliestSessionAt, staffC[0]?.earliestISO,
    ].every((x) => x === cEarliest.toISOString()) && (ovC?.session.detail ?? "").includes("filming can start from Wed, Nov 4, 2:00 PM ET"),
    `${schC?.earliestISO} · ${staffC[0]?.text} · ${ovC?.session.detail}`);
    const cPlan = await planRow(Cm, 1, false);
    const cAsk = await actions.portalRequestSession({ token: Cm.portalToken }, { monthId: Cm.monthId, when: "Any weekday afternoon", planId: cPlan.id, addressVersion: 1 });
    const cAskRow = cAsk.requestId ? await prisma.programSessionRequest.findUnique({ where: { id: cAsk.requestId } }) : null;
    const cTask = cAskRow ? await deskTask(cAskRow.id) : null;
    c.ok("…and a free-text ask ('Any weekday afternoon') tells Kyle the same instant, from the request's snapshot",
      cAsk.ok && cAskRow?.gateEarliestAt?.getTime() === cEarliest.getTime() && (cTask?.description ?? "").includes("Earliest start allowed: Wed, Nov 4, 2:00 PM ET (72 weekday hours after the strategy call ends, Fri, Oct 30, 2:00 PM ET)."),
      (cTask?.description ?? cAsk.message).split("\n").find((l) => /Earliest/.test(l)) ?? cAsk.message);
    const vW = await viewerOf(Wm.portalToken);
    const schW = (await portal.portalScheduleMonths(vW.enrollment)).find((m) => m.monthId === Wm.monthId);
    const staffW = await ws.loadSessionGates({ id: Wm.monthId }, { now: NOW0 });
    c.ok("written route — portal gate = schedule card = staff Sessions view = the request's snapshot", [gW.earliest.toISOString(), staffW[0]?.earliestISO, wRow?.gateEarliestAt?.toISOString()].every((x) => x === wEarliest.toISOString()) && (schW?.sessions.length ?? 0) + (schW?.requests.length ?? 0) > 0, `${schW?.earliestISO} ${staffW[0]?.text}`);
    const E2 = await buildContentMonth(db, { name: "Rhea Reminder TEST", package: "Starter", videosPerMonth: 1, project: false, owner: { email: "drill-rhea@realtourpilot.com" }, topics: [{ title: "Reminder topic", selection: "SELECTED" }] });
    await prisma.contentMonth.update({ where: { id: E2.monthId }, data: { planningMode: "WRITTEN" } });
    await interview(E2, E2.topicIds[0], "SUBMITTED", et(2026, 10, 29, 9));
    const remW = await primaryLane(E2.monthId, NOW0);
    const gE2 = await portal.sessionGate(E2.enrollmentId, E2.monthId, { now: NOW0 });
    c.ok("written route — the BOOK_SESSION reminder quotes the portal gate's instant (Tue Nov 3 9:00 AM EST)", remW.candidate.action === "BOOK_SESSION" && remW.candidate.state.earliestSessionAt === gE2.earliest.toISOString() && gE2.earliest.getTime() === wEarliest.getTime() && /Tuesday, November 3 at 9:00 AM ET/.test(remW.body ?? ""), `${remW.candidate.action} ${remW.candidate.state.earliestSessionAt}`);
    const E3 = await buildContentMonth(db, { name: "Ray Longago TEST", package: "Starter", videosPerMonth: 1, project: false, owner: { email: "drill-ray@realtourpilot.com" }, topics: [{ title: "Old answers topic", selection: "SELECTED" }] });
    await prisma.contentMonth.update({ where: { id: E3.monthId }, data: { planningMode: "WRITTEN" } });
    await interview(E3, E3.topicIds[0], "SUBMITTED", et(2026, 10, 5, 9));
    const remOld = await primaryLane(E3.monthId, NOW0);
    c.ok("a window that closed weeks ago is not quoted as 'the earliest we can film' (the picker offers tomorrow on)", remOld.candidate.action === "BOOK_SESSION" && !!remOld.body && !/earliest we can film/i.test(remOld.body) && remOld.candidate.state.earliestSessionAt === et(2026, 10, 8, 9).toISOString(), remOld.body?.split("\n")[2]);
    const callers = (fn: string) => srcFiles("src").filter((f) => new RegExp(`\\b${fn}\\s*\\(`).test(code(read(f))) && !code(read(f)).includes(`export function ${fn}(`));
    const weekdayCallers = callers("addWeekdayHoursET");
    c.ok("nothing outside programMonths calls addWeekdayHoursET", weekdayCallers.length === 0, weekdayCallers.join(", "));
    const seamCallers = callers("earliestFilmingStart").sort();
    c.ok("earliestFilmingStart (the arithmetic seam) outside programMonths: only a HYPOTHETICAL call's preview (callBooking) and a stored snapshot's own window (sessionReassess)", JSON.stringify(seamCallers) === JSON.stringify(["src/lib/callBooking.ts", "src/lib/sessionReassess.ts"]), seamCallers.join(", "));

    // =======================================================================
    c.head("6 · §6.6 — a legacy-stamped call with no record (OLD first)");
    // =======================================================================
    {
      const stamped = (status: string, at: Date, now = NOW0) => ({ now, month: monthIn({ planningMode: "CALL", strategyCallStatus: status, strategyCallAt: at }), enrollment: { callMode: "REQUIRED", strategyCallRequired: true, noCallEligible: false }, records: [], scripts: [], interviews: [], topics: [topicIn("A", 1, null)], plan: { videosPerMonth: 1, sessionsPerMonth: 1 } });
      const oldL = oldPM.deriveMonthState(stamped("COMPLETED", et(2026, 10, 26, 14)) as never);
      c.ok("OLD: a month stamped COMPLETED with no call record could NEVER open filming", oldL.earliestSessionAt === null);
      const newL = pm.deriveMonthState(stamped("COMPLETED", et(2026, 10, 26, 14)));
      const gL = pm.preparationGate(newL);
      c.ok("NEW: open from the stamped START (Mon 2 PM → Thu 2 PM), estimated, and the reason says there is no record", wall(gL.earliest) === "Thu, Oct 29, 2:00 PM" && gL.anchor?.estimated === true && gL.anchor.ref.startsWith("CALL_END:legacy:") && newL.reasons.some((r) => /no call record/.test(r)), wall(gL.earliest));
      c.ok("…and Kyle is asked to confirm the call's end (CONFIRM_CALL_END)", newL.followUps.some((f) => f.kind === "CONFIRM_CALL_END" && f.owner === "KYLE"));
      const future = pm.deriveMonthState(stamped("SCHEDULED", et(2026, 11, 2, 11)));
      c.ok("a stamped SCHEDULED call ahead (Mon Nov 2 11 AM EST) opens from its start too (Thu Nov 5 11 AM)", wall(pm.preparationGate(future).earliest) === "Thu, Nov 5, 11:00 AM" && future.followUps.some((f) => f.kind === "CONFIRM_CALL_END"), wall(future.earliestSessionAt));
      const august = pm.deriveMonthState(stamped("COMPLETED", et(2026, 8, 10, 14)));
      c.ok("a past August month opens but raises nothing (its window is long over)", august.earliestSessionAt !== null && !august.followUps.some((f) => f.kind === "CONFIRM_CALL_END"));
      // Batch-3 review (Sep 25 2026): a COMPLETED the recalc persisted FROM a
      // record, whose record then died, is not a legacy stamp. OLD (810b29f)
      // kept this month shut; this batch's legacy anchor had opened it from
      // the dead call's start.
      const callAt = et(2026, 10, 26, 14);
      const deadRec = (status: string) => ({ id: "rec-dead", callType: "MONTHLY_STRATEGY", status, matchState: "MATCHED", scheduledStart: callAt, scheduledEnd: et(2026, 10, 26, 14, 30), transcriptState: "NONE", createdAt: et(2026, 10, 20, 9) });
      const withRecords = (status: string, transcriptText: string | null = null) => ({ ...stamped("COMPLETED", callAt), month: monthIn({ planningMode: "CALL", strategyCallStatus: "COMPLETED", strategyCallAt: callAt, transcriptText }), records: [deadRec(status)] });
      const oldDead = oldPM.deriveMonthState(withRecords("CANCELLED") as never);
      c.ok("OLD (810b29f): a stored COMPLETED whose only record was cancelled stayed shut", oldDead.earliestSessionAt === null);
      for (const status of ["CANCELLED", "NO_SHOW"]) {
        const d = pm.deriveMonthState(withRecords(status));
        const g = pm.preparationGate(d);
        c.ok(`NEW: its only record ${status} → shut, 'book your call' (NOT_SCHEDULED), no legacy anchor, no CONFIRM_CALL_END`, g.locked && d.strategyCallStatus === "NOT_SCHEDULED" && g.lock === "BOOK_CALL" && !d.followUps.some((f) => f.kind === "CONFIRM_CALL_END"), `${d.strategyCallStatus} ${g.lock} ${wall(g.earliest)}`);
      }
      const pasted = pm.deriveMonthState(withRecords("CANCELLED", "a pasted transcript"));
      c.ok("…a transcript pasted on the month is still legacy truth: COMPLETED kept, measured from its stamp", pasted.strategyCallStatus === "COMPLETED" && pm.preparationGate(pasted).anchor?.ref.startsWith("CALL_END:legacy:") === true, `${pasted.strategyCallStatus} ${pm.preparationGate(pasted).anchor?.ref}`);
    }
    const Lm = await buildContentMonth(db, { name: "Lou Legacy TEST", package: "Starter", project: false, topics: [{ title: "Legacy topic", selection: "SELECTED" }] });
    await prisma.contentMonth.update({ where: { id: Lm.monthId }, data: { planningMode: "CALL", strategyCallStatus: "COMPLETED", strategyCallAt: et(2026, 10, 26, 14) } });
    const gL = await portal.sessionGate(Lm.enrollmentId, Lm.monthId, { now: NOW0 });
    c.ok("the portal gate for that month is open (floor: tomorrow 10 AM), no longer 'still preparing'", !gL.locked && gL.earliest.getTime() === et(2026, 10, 30, 10).getTime() && gL.preparation?.earliest?.getTime() === et(2026, 10, 29, 14).getTime(), `${gL.locked} ${gL.reason} ${wall(gL.earliest)}`);
    for (let i = 0; i < 3; i++) await pm.recalcProgramMonth(Lm.monthId, { now: NOW0 });
    const endTasks = () => prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: `program-call-end:${Lm.monthId}:` } }, select: { dedupeKey: true, status: true, assignedKey: true, title: true, description: true } });
    const lt = await endTasks();
    c.ok("three recalculations → ONE open task for Kyle: 'Confirm the strategy call's end time'", lt.length === 1 && lt[0].status === "OPEN" && lt[0].assignedKey === "kyle" && /Confirm the strategy call's end time/.test(lt[0].title) && /Nothing has been moved or cancelled/.test(lt[0].description ?? ""), lt.map((t) => `${t.status} ${t.title}`).join(" | "));
    await callRecord(Lm, et(2026, 10, 26, 14), et(2026, 10, 26, 14, 30), "COMPLETED");
    await pm.recalcProgramMonth(Lm.monthId, { now: NOW0 });
    const lt2 = await endTasks();
    const gL2 = pm.preparationGate((await pm.recalcProgramMonth(Lm.monthId, { dryRun: true, now: NOW0 }))!.after);
    c.ok("the call record lands → the task closes itself and the window runs from the real end (Thu 2:30 PM)", lt2.length === 1 && lt2[0].status === "COMPLETED" && wall(gL2.earliest) === "Thu, Oct 29, 2:30 PM" && gL2.anchor?.estimated === false, `${lt2[0]?.status} ${wall(gL2.earliest)}`);

    // =======================================================================
    c.head("7 · A24 — Pro: two sessions, each held to its own material (OLD first)");
    // =======================================================================
    const Pm = await buildContentMonth(db, { name: "Pat Pro TEST", package: "Pro", project: false, topics: ["P1", "P2", "P3", "P4", "P5", "P6"].map((title) => ({ title, selection: "SELECTED" as const })) });
    await prisma.contentEnrollment.update({ where: { id: Pm.enrollmentId }, data: { callMode: "OPTIONAL_WRITTEN" } });
    await prisma.contentMonth.update({ where: { id: Pm.monthId }, data: { planningMode: "WRITTEN", planningChosenAt: new Date() } });
    for (const [i, id] of Pm.topicIds.slice(0, 4).entries()) await interview(Pm, id, "SUBMITTED", et(2026, 10, 29, 5 + i));
    const pNow = await pm.recalcProgramMonth(Pm.monthId, { dryRun: true, now: NOW0 });
    const pTopics = pNow!.after.sessions;
    {
      const pureTopics = Pm.topicIds.map((id, i) => topicIn(id, i, i < 4 ? SUB(et(2026, 10, 29, 5 + i)) : null));
      const oldP = oldPM.deriveMonthState(writtenInput({ now: NOW0, topics: pureTopics, videos: 8, sessions: 2 }) as never);
      c.ok("OLD: the month-wide gate (what every booking read) was OPEN on session 1's material alone — session 2 bookable on it", oldP.earliestSessionAt !== null && oldP.sessions[1]?.earliestSessionAt === null, wall(oldP.earliestSessionAt));
    }
    c.ok("NEW: session 1 open from its own answers (Thu 8 AM EDT → Tue Nov 3 8 AM EST); session 2 shut (2 of 4 chosen)", wall(pTopics[0].earliestSessionAt) === "Tue, Nov 3, 8:00 AM" && pTopics[1].earliestSessionAt === null && pTopics[1].lock === "UNDER_PLANNED", `${wall(pTopics[0].earliestSessionAt)} / ${pTopics[1].lock}`);
    const gatesP = await portal.sessionGatesFor(Pm.enrollmentId, Pm.monthId, { now: NOW0 });
    c.ok("the portal's per-session gates agree, and session 2's lock is in plain words for THAT session", !gatesP.sessions[0].locked && gatesP.sessions[1].locked && /Choose all the topics for your second session/.test(gatesP.sessions[1].reason) && !/—/.test(gatesP.sessions[1].reason), gatesP.sessions[1].reason);
    const p1 = await planRow(Pm, 1);
    const p2 = await planRow(Pm, 2);
    const ask2 = await actions.portalRequestSession({ token: Pm.portalToken }, { monthId: Pm.monthId, slotISO: et(2026, 11, 5, 9).toISOString(), planId: p2.id, addressVersion: 1, sessionIndex: 2 });
    c.ok("a request for session 2 is refused by session 2's own gate — nothing written", !ask2.ok && /second session/.test(ask2.message) && (await prisma.programSessionRequest.count({ where: { monthId: Pm.monthId } })) === 0, ask2.message);
    const ask1 = await actions.portalRequestSession({ token: Pm.portalToken }, { monthId: Pm.monthId, slotISO: et(2026, 11, 3, 9).toISOString(), planId: p1.id, addressVersion: 1, sessionIndex: 1 });
    const p1Row = ask1.requestId ? await prisma.programSessionRequest.findUnique({ where: { id: ask1.requestId } }) : null;
    c.ok("session 1 at Tue 9 AM: accepted, stored as session 1", ask1.ok && p1Row?.sessionIndex === 1 && p1Row.planId === p1.id, ask1.message);
    const again1 = await actions.portalRequestSession({ token: Pm.portalToken }, { monthId: Pm.monthId, slotISO: et(2026, 11, 4, 9).toISOString(), planId: p1.id, addressVersion: 1, sessionIndex: 1 });
    c.ok("a second, different time for session 1 (another tab) is refused — one live ask per session", !again1.ok && /already requested/.test(again1.message) && (await prisma.programSessionRequest.count({ where: { monthId: Pm.monthId, status: "REQUESTED" } })) === 1, again1.message);
    const p1Task = p1Row ? await deskTask(p1Row.id) : null;
    c.ok("Kyle's task says which: 'Book content session 1 of 2'", /^Book content session 1 of 2 — Pat Pro TEST/.test(p1Task?.title ?? ""), p1Task?.title);
    const vP = await viewerOf(Pm.portalToken);
    const schP = (await portal.portalScheduleMonths(vP.enrollment)).find((m) => m.monthId === Pm.monthId);
    c.ok("the picker now books session 2, whose gate is shut; both sessions' gates are listed", schP?.sessionIndex === 2 && schP.locked && schP.sessionGates.length === 2 && !schP.sessionGates[0].locked && schP.sessionGates[1].locked, `${schP?.sessionIndex} ${schP?.locked} ${JSON.stringify(schP?.sessionGates.map((g) => g.locked))}`);
    const asg = pm.assignSessionIndexes([{ key: "late", sessionIndex: null, at: et(2026, 11, 5, 9) }, { key: "early-2", sessionIndex: 2, at: et(2026, 11, 3, 9) }], 2);
    const asgLegacy = pm.assignSessionIndexes([{ key: "b", sessionIndex: null, at: et(2026, 11, 5, 9) }, { key: "a", sessionIndex: null, at: et(2026, 11, 3, 9) }], 2);
    c.ok("legacy rows (no index) fall back to slot order; an explicit index is kept first", asg.byKey.get("early-2") === 2 && asg.byKey.get("late") === 1 && asgLegacy.byKey.get("a") === 1 && asgLegacy.byKey.get("b") === 2 && asgLegacy.free.length === 0);
    // A card carries its session index: a session booked AS session 2.
    const P2 = await buildContentMonth(db, { name: "Pia Second TEST", package: "Pro", appointments: [{ startAt: et(2026, 11, 2, 10), durationMin: 240 }] });
    const appt = await prisma.appointment.findFirstOrThrow({ where: { projectId: P2.projectId! }, select: { aryeoId: true } });
    await prisma.programSessionRequest.create({ data: { enrollmentId: P2.enrollmentId, clientId: P2.clientId, monthId: P2.monthId, status: "CONFIRMED", confirmedAt: new Date(), slotStart: et(2026, 11, 2, 10), slotEnd: et(2026, 11, 2, 14), projectId: P2.projectId, aryeoAppointmentId: appt.aryeoId, sessionIndex: 2, dedupeKey: `${P2.enrollmentId}:${P2.monthId}:s2` } });
    const pair = [{ enrollmentId: P2.enrollmentId, monthId: P2.monthId, monthKey: MONTH }];
    const newProg = (await mp.monthProgressMany(pair, { now: NOW0 })).get(mp.progressKey(P2.enrollmentId, P2.monthId, MONTH));
    const oldProg = (await oldMP.monthProgressMany(pair, { now: NOW0 })).get(oldMP.progressKey(P2.enrollmentId, P2.monthId, MONTH));
    c.ok("OLD monthProgress: a session had no index (every screen said 'Session 1' by position)", !!oldProg && (oldProg.sessions.list[0] as { sessionIndex?: number }).sessionIndex === undefined);
    c.ok("NEW: the session booked AS session 2 reads 2 on the staff fact and the client card; the next to book is 1", newProg?.sessions.list[0]?.sessionIndex === 2 && mp.clientMonthProgress(newProg).sessions.cards[0]?.sessionIndex === 2 && (await pm.monthSessionIndexes(P2.monthId, P2.clientId, 2, NOW0)).next === 1, `${newProg?.sessions.list[0]?.sessionIndex}`);
    // Batch-3 review (Sep 25 2026): a session held WITHOUT the column — an ask
    // from before sessionIndex existed, or a session Kyle booked by hand — still
    // holds its session. The check used to count the column only, so "Session 1
    // of 2" over such a row admitted the month's second session as 1 without
    // session 2's gate ever being read, and renumbered the held one as 2.
    await prisma.programSessionRequest.update({ where: { id: p1Row!.id }, data: { sessionIndex: null } });
    const schL = (await portal.portalScheduleMonths(vP.enrollment)).find((m) => m.monthId === Pm.monthId);
    c.ok("an ask with no index holds session 1 by slot order: the picker lists it as taken (no 'Session 1 of 2' tab)", !!schL && schL.takenIndexes.includes(1) && schL.sessionIndex === 2, JSON.stringify({ taken: schL?.takenIndexes, next: schL?.sessionIndex }));
    const legacy1 = await actions.portalRequestSession({ token: Pm.portalToken }, { monthId: Pm.monthId, slotISO: et(2026, 11, 4, 9).toISOString(), planId: p1.id, addressVersion: 1, sessionIndex: 1 });
    c.ok("…and 'session 1' asked over it (a stale tab) is refused: session 2's gate is never skipped", !legacy1.ok && /already requested or booked/.test(legacy1.message) && (await prisma.programSessionRequest.count({ where: { monthId: Pm.monthId, status: "REQUESTED" } })) === 1, legacy1.message);
    await prisma.programSessionRequest.update({ where: { id: p1Row!.id }, data: { sessionIndex: 1 } });
    const Hm = await buildContentMonth(db, { name: "Hal Hand TEST", package: "Pro", appointments: [{ startAt: et(2026, 11, 2, 10), durationMin: 240 }] });
    const handAppt = await prisma.appointment.findFirstOrThrow({ where: { projectId: Hm.projectId! }, select: { aryeoId: true } });
    const srq = await import("@/lib/sessionRequests");
    const askFor = (idx: number, start: Date) => srq.createSessionRequest({ enrollmentId: Hm.enrollmentId, monthId: Hm.monthId, slot: { startISO: start.toISOString(), endISO: new Date(start.getTime() + 4 * 3_600_000).toISOString() }, actor: { kind: "STAFF", userId: null }, sessionIndex: idx });
    const h1 = await askFor(1, et(2026, 11, 9, 9));
    c.ok("a session Kyle booked by hand (no request row) holds session 1: an ask 'for session 1' is refused", !h1.ok && /already requested or booked/.test(h1.reason), h1.ok ? "accepted" : h1.reason);
    const h2 = await askFor(2, et(2026, 11, 9, 9));
    const h2Row = h2.ok ? await prisma.programSessionRequest.findUnique({ where: { id: h2.id }, select: { sessionIndex: true } }) : null;
    const hIdx = await pm.monthSessionIndexes(Hm.monthId, Hm.clientId, 2, NOW0);
    c.ok("…the same time asked as session 2 is session 2, and the hand booking keeps index 1 (never renumbered)", h2.ok && h2Row?.sessionIndex === 2 && hIdx.byKey.get(`appt:${handAppt.aryeoId}`) === 1, JSON.stringify({ ok: h2.ok, idx: h2Row?.sessionIndex, hand: hIdx.byKey.get(`appt:${handAppt.aryeoId}`) }));
    // The reminder follows session 2's OWN gate (batch-3 review, Sep 25 2026):
    // session 1 answered and booked, session 2's topics not all chosen. The
    // evaluator's "planned enough" is month-level, so it asked the client to
    // book the second session the portal would not let them book.
    const Rm = await buildContentMonth(db, { name: "Remy Reminder TEST", package: "Pro", owner: { email: "info+remy@realtourpilot.com" }, topics: ["R1", "R2", "R3", "R4", "R5", "R6"].map((title) => ({ title, selection: "SELECTED" as const })), appointments: [{ startAt: et(2026, 11, 3, 9), durationMin: 240 }] });
    await prisma.contentEnrollment.update({ where: { id: Rm.enrollmentId }, data: { callMode: "OPTIONAL_WRITTEN" } });
    await prisma.contentMonth.update({ where: { id: Rm.monthId }, data: { planningMode: "WRITTEN", planningChosenAt: new Date() } });
    // Early in the month (Wed Oct 7), before the 15th's own paragraph takes over.
    const EARLY = et(2026, 10, 7, 10);
    for (const [i, id] of Rm.topicIds.slice(0, 4).entries()) await interview(Rm, id, "SUBMITTED", et(2026, 10, 2, 5 + i));
    await pm.recalcProgramMonth(Rm.monthId, { now: EARLY });
    await prisma.connection.upsert({ where: { provider: "aryeo" }, create: { provider: "aryeo", status: "CONNECTED", lastSyncedAt: EARLY }, update: { status: "CONNECTED", lastSyncedAt: EARLY, lastError: null } });
    const remR = await primaryLane(Rm.monthId, EARLY);
    const g2R = pm.preparationGate((await pm.recalcProgramMonth(Rm.monthId, { dryRun: true, now: EARLY }))!.after, 2);
    c.ok("(session 1 booked; session 2's own gate shut: UNDER_PLANNED)", g2R.locked && g2R.lock === "UNDER_PLANNED", `${g2R.lock}`);
    c.ok("the reminder asks for session 2's topics and answers (COMPLETE_ANSWERS), not 'book your second session'", remR.candidate.action === "COMPLETE_ANSWERS" && remR.candidate.sessionOrdinal === 2, `${remR.candidate.action} ${remR.candidate.decision} ${remR.candidate.suppressionReason ?? ""} s${remR.candidate.sessionOrdinal}`);
    c.ok("…and says which session and what it needs, in plain words", /session 2 of 2/.test(remR.candidate.extraParagraph ?? "") && /choose its topics and answer their questions/.test(remR.candidate.extraParagraph ?? "") && !/—/.test(remR.candidate.extraParagraph ?? ""), remR.candidate.extraParagraph ?? "none");

    // =======================================================================
    c.head("8 · A21 — Schedule later, per session; the reminder lane unchanged");
    // =======================================================================
    const Sm = await buildContentMonth(db, { name: "Sam Later TEST", package: "Pro", topics: [{ title: "Later topic", selection: "SELECTED" }] });
    await prisma.contentEnrollment.update({ where: { id: Sm.enrollmentId }, data: { callMode: "OPTIONAL_WRITTEN", noCallEligible: true } });
    await prisma.contentMonth.update({ where: { id: Sm.monthId }, data: { planningMode: "CALL", planningChosenAt: new Date() } });
    // A call already held in September: this month may be planned either way (§3).
    const sep = await prisma.contentMonth.create({ data: { enrollmentId: Sm.enrollmentId, clientId: Sm.clientId, monthKey: "2026-09", videosOwed: 8, status: "CLOSED", strategyCallStatus: "COMPLETED" }, select: { id: true } });
    await callRecord(Sm, et(2026, 9, 8, 10), et(2026, 9, 8, 10, 30), "COMPLETED", sep.id);
    await callRecord(Sm, et(2026, 10, 30, 13, 30), et(2026, 10, 30, 14));
    const vS = await viewerOf(Sm.portalToken);
    const ownerS = ownerOf(vS, Sm);
    const lanesOf = async () => (await reminders.previewReminders(Sm.monthId, { now: NOW0 })).lanes.map((l) => `${l.lane}:${l.candidate.action}:${l.candidate.decision}:${l.candidate.suppressionReason ?? ""}`);
    const remBefore = await lanesOf();
    const ledgerBefore = await prisma.programReminder.count();
    const later = await actions.portalScheduleLater({ token: Sm.portalToken }, Sm.monthId);
    const plan1 = await prisma.programSessionPlan.findUnique({ where: { monthId_sessionIndex: { monthId: Sm.monthId, sessionIndex: 1 } } });
    await actions.portalScheduleLater({ token: Sm.portalToken }, Sm.monthId);
    const plan1b = await prisma.programSessionPlan.findUnique({ where: { monthId_sessionIndex: { monthId: Sm.monthId, sessionIndex: 1 } } });
    c.ok("Schedule later (no index) defers the NEXT session — session 1 — on its own plan row, once (a second tap keeps the stamp)",
      later.ok && !/—/.test(later.message) && !!plan1?.schedulingDeferredAt && plan1.lastStep === "DEFERRED" && plan1b?.schedulingDeferredAt?.getTime() === plan1.schedulingDeferredAt.getTime() && (await prisma.programSessionPlan.count({ where: { monthId: Sm.monthId } })) === 1,
      later.message);
    const sch1 = (await portal.portalScheduleMonths(vS.enrollment)).find((m) => m.monthId === Sm.monthId);
    c.ok("…the schedule card reads it back for session 1", sch1?.sessionIndex === 1 && sch1.deferredAtISO === plan1?.schedulingDeferredAt?.toISOString());
    const bookS = (await homeActionsOf(ownerS)).find((a) => a.kind === "BOOK_SESSION");
    c.ok("Home keeps ONE 'Book filming' action, saying the client chose to schedule later (no em dash)", !!bookS && bookS.detail === "You chose to schedule later. Book any time.", bookS?.detail ?? "none");
    const remAfter = await lanesOf();
    c.ok("the reminder lanes are identical before and after, and deferring wrote no reminder row", JSON.stringify(remAfter) === JSON.stringify(remBefore) && remAfter.some((l) => l.startsWith("PRIMARY:BOOK_SESSION")) && (await prisma.programReminder.count()) === ledgerBefore, remAfter.join(" | "));
    const sProject = await prisma.project.findFirstOrThrow({ where: { contentMonthId: Sm.monthId }, select: { id: true } });
    await prisma.appointment.create({ data: { projectId: sProject.id, aryeoId: "b3-gates-sam-1", startAt: et(2026, 11, 5, 10), endAt: et(2026, 11, 5, 14), durationMin: 240, status: "SCHEDULED", title: "Content session 1" } });
    const sch2 = (await portal.portalScheduleMonths(vS.enrollment)).find((m) => m.monthId === Sm.monthId);
    c.ok("session 1 booked → the picker moves to session 2, which the client has NOT deferred", sch2?.sessionIndex === 2 && sch2.deferredAtISO === null, `${sch2?.sessionIndex} ${sch2?.deferredAtISO}`);
    const later2 = await actions.portalScheduleLater({ token: Sm.portalToken }, Sm.monthId, 2);
    const sch3 = (await portal.portalScheduleMonths(vS.enrollment)).find((m) => m.monthId === Sm.monthId);
    c.ok("Schedule later for session 2 is its own row and its own stamp", later2.ok && !!sch3?.deferredAtISO && (await prisma.programSessionPlan.count({ where: { monthId: Sm.monthId } })) === 2);
    const counts = async () => JSON.stringify(await Promise.all([
      prisma.programSessionRequest.count({ where: { monthId: Sm.monthId } }), prisma.contentScript.count({ where: { monthId: Sm.monthId } }),
      prisma.programCallRecord.count({ where: { enrollmentId: Sm.enrollmentId } }), prisma.programSessionPlan.count({ where: { monthId: Sm.monthId } }),
      prisma.appointment.count({ where: { projectId: sProject.id, status: "SCHEDULED" } }),
    ]));
    const before = await counts();
    const sw1 = await actions.portalPlanWithoutCall({ token: Sm.portalToken }, Sm.monthId);
    const sw2 = await actions.portalPlanWithCall({ token: Sm.portalToken }, Sm.monthId);
    const sw3 = await actions.portalPlanWithoutCall({ token: Sm.portalToken }, Sm.monthId);
    const sw4 = await actions.portalPlanWithCall({ token: Sm.portalToken }, Sm.monthId);
    c.ok("switching route twice (CALL → WRITTEN → CALL → WRITTEN → CALL) creates and cancels nothing", [sw1, sw2, sw3, sw4].every((x) => x.ok) && (await counts()) === before, `${[sw1, sw2, sw3, sw4].map((x) => x.ok).join(",")} ${before} → ${await counts()}`);

    // =======================================================================
    c.head("9 · §6.6 — inside 24 hours is Kyle's number (ALREADY_FIXED, confirmed at HEAD)");
    // =======================================================================
    const Km = await buildContentMonth(db, { name: "Kit Soon TEST", package: "Starter", project: false, topics: [{ title: "Soon topic", selection: "SELECTED" }] });
    await prisma.contentMonth.update({ where: { id: Km.monthId }, data: { planningMode: "CALL" } });
    await callRecord(Km, et(2026, 10, 26, 14), et(2026, 10, 26, 14, 30), "COMPLETED");
    const kReq = await prisma.programSessionRequest.create({ data: { enrollmentId: Km.enrollmentId, clientId: Km.clientId, monthId: Km.monthId, status: "CONFIRMED", confirmedAt: new Date(), slotStart: et(2026, 10, 30, 9), slotEnd: et(2026, 10, 30, 11), sessionIndex: 1, dedupeKey: `${Km.enrollmentId}:${Km.monthId}:soon` } });
    const kCancel = await actions.portalCancelSessionRequest({ token: Km.portalToken }, kReq.id);
    const kMove = await actions.portalRescheduleSession({ token: Km.portalToken }, kReq.id, { slotISO: et(2026, 11, 4, 10).toISOString() });
    const kAfter = await prisma.programSessionRequest.findUnique({ where: { id: kReq.id }, select: { status: true, slotStart: true } });
    const kSch = (await portal.portalScheduleMonths((await viewerOf(Km.portalToken)).enrollment)).find((m) => m.monthId === Km.monthId);
    c.ok("cancel and move inside 24 hours: both answer with Kyle's number (215) 645-4889", !kCancel.ok && /\(215\) 645-4889/.test(kCancel.message) && !kMove.ok && /\(215\) 645-4889/.test(kMove.message), `${kCancel.message} / ${kMove.message}`);
    c.ok("…nothing written (still CONFIRMED at Fri 9 AM, no new row), and the buttons are hidden", kAfter?.status === "CONFIRMED" && kAfter.slotStart?.getTime() === et(2026, 10, 30, 9).getTime() && (await prisma.programSessionRequest.count({ where: { monthId: Km.monthId } })) === 1 && kSch?.requests.find((r) => r.id === kReq.id)?.canChange === false);

    // =======================================================================
    c.head("10 · the words (§3's rule, plainly; no em dashes)");
    // =======================================================================
    const terms = code(read("src/components/portal/PortalPage.tsx"));
    c.ok("OLD terms: 'Sessions are booked after your call … a few business days'", /a few business days between the call and the shoot/.test(show("src/components/portal/PortalPage.tsx")));
    c.ok("NEW terms: both routes, 72 weekday hours, Kyle inside 24 hours", /72 weekday hours \(three weekdays, Monday to Friday\) after your answers were sent or after your call ends/.test(terms) && /Inside 24 hours, call or text Kyle at \(215\) 645-4889/.test(terms) && !/a few business days/.test(terms));
    const choice = code(read("src/components/portal/PlanningChoice.tsx"));
    const sched = code(read("src/components/portal/tabs/ScheduleTab.tsx"));
    c.ok("OLD route card / schedule tab: 'opens a few business days after'", /opens a few business days after/.test(show("src/components/portal/PlanningChoice.tsx")) && /opens a few business days after/.test(show("src/components/portal/tabs/ScheduleTab.tsx")));
    c.ok("NEW: 'as soon as your answers are in' / 'as soon as the call is', 72 weekday hours, no 'few business days'", !/few business days/.test(choice + sched) && /Filming can be booked as soon as the call is/.test(choice) && /72 weekday hours/.test(choice) && /You can book filming now, before the call/.test(sched));
    const g04 = read("docs/portal-guides/04-preparing-for-your-session.md");
    const gj = JSON.parse(read("docs/portal-guides/guides.json")) as { guides: { slug: string; body: string }[] };
    const g04j = gj.guides.find((g) => g.slug === "preparing-for-your-filming-session")?.body ?? "";
    c.ok("OLD guide: 'at least two full weekdays away' and 'You can book with a general area'", /two full weekdays/.test(show("docs/portal-guides/04-preparing-for-your-session.md")) && /general area/.test(show("docs/portal-guides/04-preparing-for-your-session.md")));
    c.ok("NEW guide (md and the generated json agree): 72 weekday hours from the answers or the call's end; exact address first", [g04, g04j].every((s) => /72 weekday hours/.test(s) && /Add the exact filming address first/.test(s) && !/two full weekdays|general area/.test(s) && !/—/.test(s)) && /72 weekday hours of preparation/.test(read("docs/portal-guides/README.md")));
    const detail = home.homeActions({
      status: "ACTIVE", readOnly: false, perms: { session: true, suggest: true, request: true, approve: true, profile: true },
      review: { count: 0, single: null, soonestDeadlineLabel: null }, scripts: [], unread: 0, planning: { planningMode: "CALL", callStatus: "SCHEDULED" },
      month: null, toAnswer: [], session: { offerBooking: true, required: 1, missing: 1, earliestLabel: "Wednesday, November 4" }, addressNeeded: 0, setup: null, ready: { count: 0, withFile: false, single: null },
    });
    c.ok("Home's booking action quotes the gate: 'Sessions can start from Wednesday, November 4.'", [detail.primary, ...detail.more].find((a) => a?.kind === "BOOK_SESSION")?.detail === "Sessions can start from Wednesday, November 4.");
    c.ok("the client-facing refusals carry no em dash (too soon, a locked session)", !/—/.test(tooSoon.message) && !/—/.test(ask2.message));
    const iflow = code(read("src/components/portal/InterviewFlow.tsx"));
    c.ok("after the last answer is sent, the next step is right there: 'Next: book your filming' → #step-filming", /#step-filming/.test(iflow) && /Next: book your filming/.test(iflow) && (/id=\{`step-\$\{/.test(read("src/components/portal/YourMonth.tsx")) || /step-filming/.test(read("src/components/portal/YourMonth.tsx"))));

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
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
