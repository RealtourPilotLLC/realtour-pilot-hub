// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Oct 28 2026, Kyle (feedback board, "Timezone unalligned with EST"): "Some
// tasks/projects show "today" as the timezone set where the person is, not
// EST". The business runs on America/New_York; the server runs UTC (Vercel)
// and a viewer's device can be set anywhere. This drill runs the hub's
// "today" decisions with the process clock in Asia/Manila (12 hours ahead of
// Eastern) and in UTC (the server), at 11:30 PM ET and 12:30 AM ET, and holds
// every one to the Eastern answer:
//   §0 the harness: Node honours a runtime TZ change (else nothing below proves anything)
//   §1 the shared helpers (lib/datetime): today, tomorrow and yesterday by ET
//      day key, right through the two clock-change days
//   §2 the dashboard's Today's Shoots: Kyle's desk card (Today / Next business
//      day), Home's Today's shoots card and its week strip
//   §3 tasks due today and overdue: Kyle's checklist, the desk's Follow-ups
//      words, and a task's priority from its shoot day
//   §4 the client "today" helpers this change touched, rendered on a Manila
//      device: the appointment reschedule field, the client texts' "by 9 AM",
//      "built yesterday", the Finished list's "Yesterday"
// Disposable PGlite; server actions are pure fakes; nothing leaves.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";

installNextStubs();
const load = createRequire(__filename);
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} });
  navigation.usePathname = () => "/";
  navigation.useSearchParams = () => new URLSearchParams("");
}
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url) => (url.startsWith("https://slack.com/api/") ? json({ ok: true, ts: "1", channel: { id: "D-DRILL" } }) : null));

// ---- the clock: pinned only around the reads that take "now" from it ----------
const RealDate = Date;
let offset = 0;
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
async function atClock<T>(iso: string, fn: () => Promise<T> | T): Promise<T> {
  offset = RealDate.parse(iso) - RealDate.now();
  try { return await fn(); } finally { offset = 0; }
}
async function inZone<T>(tz: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
}

// ---- the server actions the client components import: pure fakes ------------
const writes: { id: string; date: string; notify: boolean }[] = [];
const fake = (rel: string, exports: Record<string, unknown>) => {
  const file = load.resolve(rel);
  load.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule;
};
fake("../../src/app/actions.ts", {
  rescheduleAppointmentAction: async (id: string, date: string, notify: boolean) => { writes.push({ id, date, notify }); return { ok: true, message: "Appointment rescheduled.", outcome: "confirmed" }; },
  cancelAppointmentAction: async () => ({ ok: true, message: "Canceled.", outcome: "confirmed" }),
  setSmartTaskStatus: async () => ({ ok: true }),
});
fake("../../src/app/tasks/sendAllActions.ts", { sendDraftText: async () => ({ ok: true }) });
fake("../../src/app/day/actions.ts", { restoreOwnerTodo: async () => ({ ok: true }) });
fake("../../src/app/trends/advisorActions.ts", { refreshGrowthPlanAction: async () => ({ plan: null, builtAt: null, stale: false }) });

// ---- the desk's other boards, empty, through their contracts (as oct25-b) ----
interceptModule((r) => r === "@/lib/jobsBoard" || /src[\\/]lib[\\/]jobsBoard(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/jobsBoard");
  return { ...m, jobsBoard: async () => ({ rows: [], counts: { total: 0, late: 0, dueToday: 0, dueTomorrow: 0, oldestLateDays: null } }) };
});
interceptModule((r) => r === "@/lib/videoDelivery" || /src[\\/]lib[\\/]videoDelivery(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/videoDelivery");
  const lanes = { late: [], today: [], review: [], upcoming: [], sending: [], held: [], finishing: [], delivered: [] };
  return { ...m, videoDeliveryBoard: async () => ({ asOf: new Date().toISOString(), lanes, counts: {}, mode: "live", connected: true }) as unknown as Awaited<ReturnType<typeof m.videoDeliveryBoard>> };
});
interceptModule((r) => r === "@/lib/reviewRoom" || /src[\\/]lib[\\/]reviewRoom(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/reviewRoom");
  return { ...m, getReviewQueue: async () => ({ pending: [], waitingOnCheck: [], waitingOnEditor: [], recentlyApproved: [], followUps: [] }) as unknown as Awaited<ReturnType<typeof m.getReviewQueue>> };
});
interceptModule((r) => r === "@/lib/opsExceptions" || /src[\\/]lib[\\/]opsExceptions(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/opsExceptions");
  return { ...m, opsExceptionsBoard: async () => m.emptyExceptionBoard() };
});
interceptModule((r) => r === "@/lib/photographerBrief" || /src[\\/]lib[\\/]photographerBrief(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/photographerBrief");
  return { ...m, briefStatusForAppointments: async (ids: string[]) => new Map(ids.map((id) => [id, { state: "off" as const, sentAt: null, ackAt: null, why: null }])) };
});

// ---- a minimal hooks host (appointment-recovery-ui's), for click-to-open UI ----
type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((typeof type === "string" ? type : type.name) === name ? [tree.props] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function contains(tree: unknown, text: string): boolean {
  if (typeof tree === "string") return tree.includes(text);
  if (Array.isArray(tree)) return tree.some((child) => contains(child, text));
  return isValidElement<Props>(tree) && contains(tree.props.children, text);
}
function mountHooks(render: () => unknown) {
  const react = load("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], effects: (() => void)[] = [], cleanups: (() => void)[] = [];
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? initial() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? next(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useMemo(fn: () => unknown, deps: unknown[]) { const slot = index++, prior = cells[slot] as { deps: unknown[]; value: unknown } | undefined; if (!prior || deps.some((v, i) => v !== prior.deps[i])) cells[slot] = { deps, value: fn() }; return (cells[slot] as { value: unknown }).value; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) { const slot = index++, old = cells[slot] as unknown[] | undefined; if (!old || deps.some((value, i) => value !== old[i])) { cells[slot] = deps; effects.push(() => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }); } },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (callback: () => Promise<unknown>) => { cells[slot] = true; void callback().finally(() => { cells[slot] = false; }); }]; },
  };
  return { render() { index = 0; const before = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H; react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher; try { const tree = render(); effects.splice(0).forEach((effect) => effect()); return tree; } finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = before; } }, stop() { cleanups.splice(0).forEach((fn) => fn()); } };
}

const H = 3_600_000;
const D = 24 * H;
// The two edges, Wednesday Oct 28 2026 (EDT, UTC-4).
const E1 = "2026-10-29T03:30:00.000Z"; // 11:30 PM ET Wed Oct 28 · 11:30 AM Thu in Manila · Thu 3:30 AM UTC
const E2 = "2026-10-29T04:30:00.000Z"; // 12:30 AM ET Thu Oct 29
const FAR = ["Asia/Manila", "UTC"] as const;
const EDGES = [["11:30 PM ET", E1], ["12:30 AM ET", E2]] as const;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5641) });
  const c = makeChecker();
  try {
    const dt = await import("@/lib/datetime");
    const { etAt, etDayKey } = dt;

    // =====================================================================
    c.head("§0 · the harness: Node honours a runtime TZ change");
    // =====================================================================
    const probe = new RealDate(Date.UTC(2026, 9, 28, 20)); // Oct 28 8 PM UTC = 4 PM ET
    const read = () => ({ h: probe.getHours(), off: probe.getTimezoneOffset(), day: probe.getDate(), zone: new Intl.DateTimeFormat().resolvedOptions().timeZone });
    const seen = [await inZone("Asia/Manila", read), await inZone("UTC", read), await inZone("America/New_York", read)]; // one zone at a time
    c.ok("Manila: the device clock reads 4 AM on Oct 29 (UTC+8), and Intl agrees", seen[0].h === 4 && seen[0].off === -480 && seen[0].day === 29 && seen[0].zone === "Asia/Manila", JSON.stringify(seen[0]));
    c.ok("UTC: 8 PM on Oct 28", seen[1].h === 20 && seen[1].off === 0 && seen[1].zone === "UTC", JSON.stringify(seen[1]));
    c.ok("New York: 4 PM on Oct 28 (EDT)", seen[2].h === 16 && seen[2].off === 240 && seen[2].zone === "America/New_York", JSON.stringify(seen[2]));
    c.ok("the pinned clock moves new Date() and Date.now() only inside atClock", await atClock(E1, () => new Date().toISOString().slice(0, 16) === E1.slice(0, 16) && Math.abs(Date.now() - RealDate.parse(E1)) < 60_000) && Math.abs(new Date().getTime() - RealDate.now()) < 1_000);

    // =====================================================================
    c.head("§1 · the shared helpers: today, tomorrow, yesterday are Eastern days");
    // =====================================================================
    for (const tz of [...FAR, "America/New_York"]) {
      await inZone(tz, async () => {
        const e1 = new Date(E1), e2 = new Date(E2);
        c.ok(`${tz}: at 11:30 PM ET it is still Oct 28; at 12:30 AM ET it is Oct 29`, etDayKey(e1) === "2026-10-28" && etDayKey(e2) === "2026-10-29" && dt.etTomorrowKey(e1) === "2026-10-29" && dt.etYesterdayKey(e2) === "2026-10-28");
        const late = etAt("2026-10-28", 22);
        const [atE1, atE2] = [await atClock(E1, () => [dt.isTodayET(late), dt.etDaysAgo(late)] as const), await atClock(E2, () => [dt.isTodayET(late), dt.isYesterdayET(late)] as const)];
        c.ok(`${tz}: 10 PM ET Oct 28 is "today" at 11:30 PM ET and "yesterday" an hour later`, atE1[0] === true && atE1[1] === 0 && atE2[0] === false && atE2[1] === true, JSON.stringify({ atE1, atE2 }));
        c.ok(`${tz}: times print in Eastern (a 9 AM ET shoot reads 9:00 AM, not the device's hour)`, dt.etTime(etAt("2026-10-28", 9)) === "9:00 AM" && dt.etMonthDay(e1) === "Oct 28");
      });
    }
    const manilaDeviceHour = await inZone("Asia/Manila", () => etAt("2026-10-28", 9).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
    c.ok("(the device clock in Manila would have said 9:00 PM for that shoot: the bug this guards)", manilaDeviceHour === "9:00 PM", manilaDeviceHour);

    // The clock-change days. Fall back: Sun Nov 1 2026 2 AM EDT. Spring forward: Sun Mar 8 2026 2 AM EST.
    const nov1Early = new Date("2026-11-01T04:30:00Z"); // 12:30 AM EDT Sun Nov 1 (a 25-hour day)
    const mar9Early = new Date("2026-03-09T04:30:00Z"); // 12:30 AM EDT Mon Mar 9 (after a 23-hour day)
    const nov1Late = new Date("2026-11-02T04:30:00Z"); // 11:30 PM EST Sun Nov 1
    for (const tz of FAR) {
      await inZone(tz, () => {
        c.ok(`${tz}: tomorrow from 12:30 AM on the 25-hour day is Nov 2 (now + 24 h said Nov 1)`, dt.etTomorrowKey(nov1Early) === "2026-11-02" && etDayKey(dt.etAddDays(nov1Early, 1)) === "2026-11-01");
        c.ok(`${tz}: yesterday from 12:30 AM after the 23-hour day is Mar 8 (now - 24 h said Mar 7)`, dt.etYesterdayKey(mar9Early) === "2026-03-08" && etDayKey(new Date(mar9Early.getTime() - D)) === "2026-03-07");
        c.ok(`${tz}: yesterday at 11:30 PM on the 25-hour day is Oct 31 (now - 24 h said Nov 1, today)`, dt.etYesterdayKey(nov1Late) === "2026-10-31" && etDayKey(new Date(nov1Late.getTime() - D)) === "2026-11-01");
        const next = dt.etDayStartPlusUtc(nov1Early, 1).toISOString(), old = dt.etDayStartUtc(dt.etAddDays(nov1Early, 1)).toISOString();
        c.ok(`${tz}: "tomorrow starts" at Nov 2 midnight EST, not back at Nov 1 midnight`, next === "2026-11-02T05:00:00.000Z" && old === "2026-11-01T04:00:00.000Z", JSON.stringify({ next, old }));
        c.ok(`${tz}: the year starts Jan 1 midnight ET; at 11:30 PM ET Dec 31 (already 2027 on the server's clock) it is still 2026's`, dt.etYearStartUtc(new Date("2027-01-01T05:30:00Z")).toISOString() === "2027-01-01T05:00:00.000Z" && dt.etYearStartUtc(new Date("2027-01-01T04:30:00Z")).toISOString() === "2026-01-01T05:00:00.000Z");
      });
    }
    // The datetime-local pair (the appointment reschedule field).
    for (const tz of FAR) {
      await inZone(tz, () => {
        const field = dt.etInputValue("2026-10-01T15:00:00.000Z");
        const typed = dt.etFromInputValue("2026-10-02T12:30");
        const deviceField = (() => { const d = new Date("2026-10-01T15:00:00.000Z"); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); })();
        c.ok(`${tz}: an 11 AM ET appointment fills the field as 11:00, and 12:30 typed is 12:30 PM ET`, field === "2026-10-01T11:00" && typed?.toISOString() === "2026-10-02T16:30:00.000Z", JSON.stringify({ field, typed }));
        c.ok(`${tz}: (the device-clock field read ${deviceField.slice(11)}: the bug this guards)`, deviceField !== field, deviceField);
        c.ok(`${tz}: across the fall-back hour, 1:30 AM typed is the first 1:30 (EDT) and a bad value is refused`, dt.etFromInputValue("2026-11-01T01:30")?.toISOString() === "2026-11-01T05:30:00.000Z" && dt.etFromInputValue("2026-11-01") === null && dt.etFromInputValue("") === null && dt.etFromInputValue("2026-13-40T99:99") === null && dt.etFromInputValue("2026-02-30T10:00") === null && dt.etFromInputValue("2026-10-28T24:00") === null);
      });
    }

    // =====================================================================
    c.head("§2 · the dashboard's Today's Shoots");
    // =====================================================================
    const { prisma } = await import("@/lib/prisma");
    const desk = await import("@/lib/officeDesk");
    const opsDay = await import("@/lib/opsDay");
    const { getShootWindow } = await import("@/lib/queries");
    const { checklistTasks } = await import("@/lib/taskAging");
    const { computePriority } = await import("@/lib/tasks");
    const { listAssignees } = await import("@/lib/assignees");

    const client = await prisma.client.create({ data: { name: "Dana Agent", phone: "2155550142" } });
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@oct28tz.invalid`, ...extra } });
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const harrison = await tm("Harrison Wells", "PHOTOGRAPHER", { isServiceProvider: true });
    await prisma.appUser.create({ data: { name: "Kyle Smith", email: kyleTm.email!, role: "ADMIN", teamMemberId: kyleTm.id, status: "ACTIVE" } });
    await prisma.appUser.create({ data: { name: "Jordan Spackman", email: "owner@oct28tz.invalid", role: "OWNER", teamMemberId: jordanTm.id, status: "ACTIVE" } });
    const roster = await listAssignees();

    const shoot = async (street: string, dayKey: string, hour: number, minute = 0) => {
      const at = etAt(dayKey, hour, minute);
      const p = await prisma.project.create({ data: { clientId: client.id, title: `${street}, Allentown, PA`, addressLine: street, status: "SCHEDULED", shootDate: at, photographerId: harrison.id } });
      const a = await prisma.appointment.create({ data: { aryeoId: `oct28tz-${street}`, projectId: p.id, startAt: at, endAt: new Date(at.getTime() + 75 * 60_000), status: "SCHEDULED", assignedToId: harrison.id, description: "Customer:\nName: Dana Agent\nPhone: (215) 555-0142" } });
      return { p, a, street };
    };
    const A = await shoot("12 Morning Rd", "2026-10-28", 9); //        Wed 9 AM ET
    const B = await shoot("40 Late Ave", "2026-10-28", 22); //         Wed 10 PM ET (Thu 2 AM UTC)
    const C = await shoot("5 Thursday Ln", "2026-10-29", 9); //        Thu 9 AM ET
    const E = await shoot("8 Evening Ct", "2026-10-29", 20, 30); //    Thu 8:30 PM ET (Fri 12:30 AM UTC)

    const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort().join(",");
    const want = (...xs: { a: { id: string } }[]) => xs.map((x) => `visit:${x.a.id}`).sort().join(",");
    const titles = (xs: { title: string }[]) => xs.map((x) => x.title.split(",")[0]).sort().join(" | ");
    const named = (...xs: { street: string }[]) => xs.map((x) => x.street).sort().join(" | ");
    const appts = (xs: { apptId: string }[]) => xs.map((x) => x.apptId).sort().join(",");
    const apptsOf = (...xs: { a: { id: string } }[]) => xs.map((x) => x.a.id).sort().join(",");
    const kyle = { key: "kyle", teamMemberId: kyleTm.id, name: "Kyle" };

    for (const tz of FAR) {
      for (const [edge, iso] of EDGES) {
        await inZone(tz, () => atClock(iso, async () => {
          const now = new Date();
          const d = await desk.buildOfficeDesk({ now, excludeClientIds: [], person: kyle, roster });
          const s = d.sections.find((x) => x.key === "shoots")!;
          const all = [...s.now, ...s.waiting, ...s.ok].filter((i) => i.id.startsWith("visit:"));
          const today = all.filter((i) => i.day === "today"), next = all.filter((i) => i.day === "next");
          const home = await opsDay.todayShootCards();
          const win = await getShootWindow();
          if (iso === E1) {
            c.ok(`${tz} @ ${edge}: Kyle's desk is Wednesday Oct 28`, d.dayKey === "2026-10-28" && d.dateWords === "Wednesday, October 28" && JSON.stringify(desk.prepDayKeys(now)) === JSON.stringify(["2026-10-28", "2026-10-29"]), JSON.stringify({ day: d.dayKey, words: d.dateWords }));
            c.ok(`${tz} @ ${edge}: Today's Shoots "Today" holds Wednesday's two (9 AM, 10 PM), never Thursday's`, ids(today) === want(A, B), JSON.stringify(today.map((i) => i.title)));
            c.ok(`${tz} @ ${edge}: "Next business day" holds Thursday's two (9 AM, 8:30 PM)`, ids(next) === want(C, E) && d.nextDay.dayKey === "2026-10-29", JSON.stringify(next.map((i) => i.title)));
            c.ok(`${tz} @ ${edge}: Home's Today's shoots card lists Wednesday's two`, titles(home) === named(A, B), titles(home));
            c.ok(`${tz} @ ${edge}: its week strip starts Thursday (today = Wed, tomorrow = Thu)`, appts(win.today) === apptsOf(A, B) && appts(win.tomorrow) === apptsOf(C, E) && appts(win.week) === apptsOf(C, E));
          } else {
            c.ok(`${tz} @ ${edge}: Kyle's desk has turned to Thursday Oct 29`, d.dayKey === "2026-10-29" && d.dateWords === "Thursday, October 29" && JSON.stringify(desk.prepDayKeys(now)) === JSON.stringify(["2026-10-29", "2026-10-30"]));
            c.ok(`${tz} @ ${edge}: "Today" is Thursday's two, the 8:30 PM one included; Wednesday's are gone`, ids(today) === want(C, E) && next.length === 0, JSON.stringify(all.map((i) => [i.title, i.day])));
            c.ok(`${tz} @ ${edge}: Home's card lists Thursday's two`, titles(home) === named(C, E), titles(home));
            c.ok(`${tz} @ ${edge}: the week strip's today is Thursday's two, nothing tomorrow`, appts(win.today) === apptsOf(C, E) && win.tomorrow.length === 0 && win.week.length === 0);
          }
        }));
      }
    }

    // =====================================================================
    c.head("§3 · tasks due today and overdue (Kyle's checklist and desk)");
    // =====================================================================
    const task = (title: string, dueAt: Date) => prisma.smartTask.create({ data: { taskType: "follow_up", source: "manual", status: "OPEN", title, assignedKey: "kyle", dueAt } });
    const t1 = await task("Call Dana back about the lockbox", etAt("2026-10-28", 19)); //    Wed 7 PM ET
    const t2 = await task("Send the Late Ave floor plan", etAt("2026-10-28", 21)); //          Wed 9 PM ET (Thu 1 AM UTC)
    const t3 = await task("Confirm Friday's twilight", etAt("2026-10-29", 10)); //            Thu 10 AM ET
    const t4 = await task("Chase the HOA letter", etAt("2026-10-27", 17)); //                 Tue 5 PM ET
    const idsOf = (xs: { id: string }[]) => xs.map((x) => x.id).sort().join(",");
    const of = (...xs: { id: string }[]) => xs.map((x) => x.id).sort().join(",");
    for (const tz of FAR) {
      for (const [edge, iso] of EDGES) {
        await inZone(tz, () => atClock(iso, async () => {
          const now = new Date();
          const list = await checklistTasks(now, { person: kyle, excludeClientIds: [], scrub: true, roster });
          const d = await desk.buildOfficeDesk({ now, excludeClientIds: [], person: kyle, roster });
          const f = d.sections.find((x) => x.key === "followups")!;
          const row = (t: { id: string }) => [...f.now, ...f.waiting].find((i) => i.id === `task:${t.id}`);
          if (iso === E1) {
            c.ok(`${tz} @ ${edge}: due today = Wednesday's 7 PM and 9 PM; Thursday's 10 AM is not on today's list`, idsOf(list.dueToday) === of(t1, t2) && idsOf(list.earlier) === of(t4), JSON.stringify({ today: list.dueToday.map((x) => x.title), earlier: list.earlier.map((x) => x.title) }));
            c.ok(`${tz} @ ${edge}: the desk says "due today" for both and "1 day past its date" for Tuesday's`, /due today/.test(row(t1)?.reason ?? "") && /due today/.test(row(t2)?.reason ?? "") && /\b1 day past its date/.test(row(t4)?.reason ?? ""), JSON.stringify([row(t1)?.reason, row(t2)?.reason, row(t4)?.reason]));
            c.ok(`${tz} @ ${edge}: Thursday's 10 AM waits as "Due later", "Due Thu, Oct 29", not today's work`, row(t3)?.state === "waiting" && row(t3)?.reason === "Due later" && /Due Thu, Oct 29/.test(row(t3)?.line ?? ""), JSON.stringify({ state: row(t3)?.state, reason: row(t3)?.reason, line: row(t3)?.line }));
            c.ok(`${tz} @ ${edge}: both of today's are late by the hour, ranked as today's work, not old`, row(t1)?.late === true && row(t1)?.rank === desk.RANK.today && row(t2)?.rank === desk.RANK.today);
          } else {
            c.ok(`${tz} @ ${edge}: due today = Thursday's 10 AM; Wednesday's two have moved to earlier days`, idsOf(list.dueToday) === of(t3) && idsOf(list.earlier) === of(t1, t2, t4), JSON.stringify({ today: list.dueToday.map((x) => x.title), earlier: list.earlier.map((x) => x.title) }));
            c.ok(`${tz} @ ${edge}: last night's 9 PM task is "1 day past its date" (24-hour blocks said 0), Tuesday's 2`, /\b1 day past its date/.test(row(t2)?.reason ?? "") && /\b1 day past its date/.test(row(t1)?.reason ?? "") && /\b2 days past its date/.test(row(t4)?.reason ?? "") && /due today/.test(row(t3)?.reason ?? ""), JSON.stringify([row(t1)?.reason, row(t2)?.reason, row(t3)?.reason, row(t4)?.reason]));
          }
        }));
      }
    }
    // A task's priority from its shoot day (lib/tasks computePriority), at 9:30 PM ET Wednesday.
    const nineThirty = etAt("2026-10-28", 21, 30);
    const oldRule = (shootDate: Date, now: Date) => { const days = Math.floor((shootDate.getTime() - new Date(now.toDateString()).getTime()) / D); return days >= 0 && days <= 1 ? "URGENT" : days > 1 && days <= 3 ? "HIGH" : "MEDIUM"; };
    for (const tz of FAR) {
      await inZone(tz, () => {
        const p = (key: string, h: number) => computePriority({ shootDate: etAt(key, h), now: nineThirty });
        c.ok(`${tz}: shoot tomorrow (Thu) is URGENT; Friday's is HIGH; Sunday's is MEDIUM`, p("2026-10-29", 9) === "URGENT" && p("2026-10-30", 9) === "HIGH" && p("2026-11-01", 9) === "MEDIUM" && p("2026-10-28", 22) === "URGENT", JSON.stringify([p("2026-10-29", 9), p("2026-10-30", 9), p("2026-11-01", 9)]));
        c.ok(`${tz}: (the server-midnight rule said Friday's was URGENT, "tomorrow": the bug this guards)`, oldRule(etAt("2026-10-30", 9), nineThirty) === "URGENT");
      });
    }

    // =====================================================================
    c.head("§4 · the client helpers this change touched, on a Manila device");
    // =====================================================================
    const { AppointmentManager } = await import("@/components/project/AppointmentManager");
    const { ClientTextsList } = await import("@/components/texts/ClientTextsList");
    const { GrowthPlanCard } = await import("@/components/trends/GrowthPlanCard");
    const { FinishedList } = await import("@/components/day/FinishedList");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } } });

    await inZone("Asia/Manila", async () => {
      // The appointment reschedule field (components/project/AppointmentManager).
      const appt = { id: "appt-oct28tz", startAt: "2026-10-01T15:00:00.000Z", endAt: "2026-10-01T16:15:00.000Z", durationMin: 75, status: "SCHEDULED", title: "12 Morning Rd", description: null, preferenceType: null, requiresConfirmation: false, canCancel: true, canReschedule: true, rescheduledAt: null, postponedAt: null, previousStartAt: null, assignedTo: { name: "Harrison Wells", avatarColor: "#123456" } };
      const card = mountHooks(() => AppointmentManager({ appt }));
      const tree = () => card.render();
      const click = (label: string) => (elements(tree(), "Button").find((p) => contains(p.children, label))!.onClick as () => void)();
      card.render(); await Promise.resolve(); click("Reschedule");
      const field = () => elements(tree(), "TextField")[0];
      c.ok("the 11 AM ET appointment opens the field at 11:00, labelled Eastern (the device clock said 23:00)", field().value === "2026-10-01T11:00" && field().label === "New date & time (Eastern)", JSON.stringify({ value: field().value, label: field().label }));
      (field().onChange as (e: { target: { value: string } }) => void)({ target: { value: "2026-10-02T12:30" } });
      click("Confirm reschedule"); await Promise.resolve();
      c.ok("12:30 typed books 12:30 PM Eastern, not 12:30 Manila (00:30 ET)", writes.length === 1 && writes[0].date === etAt("2026-10-02", 12, 30).toISOString(), JSON.stringify(writes));
      card.stop();

      // The client texts' due chip (components/texts/ClientTextsList).
      const textRow = (id: string, dueAt: Date) => ({ id, taskType: "confirmation_text", title: `Confirm ${id}`, summary: null, draft: "Hi Dana, confirming the shoot.", clientName: "Dana Agent", hasPhone: true, street: id, projectId: null, dueAt: dueAt.toISOString(), overdue: false, warnStale: false, warnQcOpen: false });
      const rows = [textRow("40 Late Ave", etAt("2026-10-28", 23, 45)), textRow("5 Thursday Ln", etAt("2026-10-29", 9))];
      const chips = (html: string) => [...html.matchAll(/rounded-full px-2 py-0\.5 text-\[11px\][^"]*">([^<]+)</g)].map((m) => m[1]);
      const atE1 = await atClock(E1, () => chips(renderToStaticMarkup(createElement(ClientTextsList, { confirmations: rows, deliveries: [] }))));
      const atE2 = await atClock(E2, () => chips(renderToStaticMarkup(createElement(ClientTextsList, { confirmations: rows, deliveries: [] }))));
      c.ok("at 11:30 PM ET: tonight's text reads \"by 11:45 PM\"; tomorrow 9 AM reads \"Oct 29\" (was \"by 9:00 AM\", within 24 hours)", JSON.stringify(atE1) === JSON.stringify(["by 11:45 PM", "Oct 29"]), JSON.stringify(atE1));
      c.ok("at 12:30 AM ET: Thursday's 9 AM text is today's, \"by 9:00 AM\"", atE2[1] === "by 9:00 AM", JSON.stringify(atE2));

      // "built yesterday" (components/trends/GrowthPlanCard), built 11 PM ET Wednesday.
      const built = etAt("2026-10-28", 23).toISOString();
      const words = (iso: string) => atClock(iso, () => /built (today|yesterday|\d+ days ago)/.exec(renderToStaticMarkup(createElement(GrowthPlanCard, { plan: null, builtAt: built, stale: false })))?.[0]);
      const [w1, w2] = [await words(E1), await words(E2)];
      c.ok("the growth plan built at 11 PM ET reads \"built today\" at 11:30 PM and \"built yesterday\" at 12:30 AM (was \"today\" for 24 hours)", w1 === "built today" && w2 === "built yesterday", JSON.stringify([w1, w2]));

      // The Finished list's "Yesterday" (components/day/FinishedList), the hour after the 23-hour day.
      const done = (id: string, doneAt: Date) => ({ id, title: id, notes: null, status: "DONE", doneAt, energy: "low", estimateMin: 15, project: null, client: null });
      const finished = await atClock("2026-03-09T04:30:00Z", () => {
        const list = mountHooks(() => FinishedList({ rows: [done("Sunday's call", etAt("2026-03-08", 15)), done("Monday's note", etAt("2026-03-09", 0, 10))] }));
        list.render();
        (elements(list.render(), "button")[0].onClick as () => void)();
        return renderToStaticMarkup(list.render() as ReactElement);
      });
      c.ok("at 12:30 AM Mon Mar 9 (after the 23-hour Sunday), Sunday's work reads \"Yesterday\", tonight's \"Today\"", finished.includes(">Yesterday<") && finished.includes(">Today<") && !finished.includes("Sun, Mar 8"), finished.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200));
    });

    // Every client file this change touched reads no device calendar.
    const touched = ["project/AppointmentManager", "texts/ClientTextsList", "trends/GrowthPlanCard", "comms/ConversationView", "day/FinishedList", "finance/ReportBuilder", "finance/BudgetTab", "finance/PersonalTab", "finance/PeopleTab", "payouts/PayoutCard", "clientCare/ClientIssuesCard"];
    const deviceReads = touched.filter((f) => /getTimezoneOffset|toDateString|\.get(FullYear|Month|Date|Day|Hours|Minutes)\(|Date\.now\(\) - 86_?400_?000|\+ ?"T12:00:00"/.test(fs.readFileSync(path.resolve(__dirname, `../../src/components/${f}.tsx`), "utf8")));
    c.ok("no device-calendar read (getHours, getDate, getTimezoneOffset, toDateString, now - 24 h) in the 11 client files touched", deviceReads.length === 0, deviceReads.join(", "));
    c.ok("ConversationView and FinishedList take yesterday from the shared ET helper", ["comms/ConversationView", "day/FinishedList"].every((f) => fs.readFileSync(path.resolve(__dirname, `../../src/components/${f}.tsx`), "utf8").includes("etYesterdayKey()")));

    c.head("Nothing left the hub");
    c.ok("the fence held", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    c.summary();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
