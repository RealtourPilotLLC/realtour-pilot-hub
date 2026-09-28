// ---------------------------------------------------------------------------
// DRILL CAPACITY-EXCEPTIONS: who is out, and when (§10 capacity and training —
// G2, G3, A4). Unified handoff, batch 5, Sep 26 2026.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/capacity-exceptions.ts
//
// Drives the SHIPPED code against an isolated PGlite on 127.0.0.1:5788 (or
// DRILL_PORT), and editorWorkload.ts as it was at 17df024 (never HEAD) for the
// old behaviour. Production is never opened; every outbound call is fenced.
//
// The rule: the hub RECORDS a capacity decision and shows it; it never makes
// one. No reassignment, no hours maths, no payroll effect.
//
//   §0  old code (17df024): an exception row existed nowhere on the panel
//   §1  the shape and the permission rule, pure
//   §2  recording through the real server actions: office for anyone, an
//       editor only their own offline/blocked; the office hears about it
//   §3  chips on the workload panel: only for that editor, now vs this week
//   §4  it ends on its own, and a cancel is a cancel (never a delete)
//   §5  byte-identical: lanes, rates, weeks-of-work and payroll with and
//       without an exception; nothing reassigned, no date moved
//   §6  fences
//
// THE CLOCK IS PINNED to Saturday Sep 26 2026, 7:30 PM ET, and moved by hand.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5788);
const BASE = "17df024";
const REPO = path.resolve(__dirname, "../..");
const HOUR = 3_600_000;

const RealDate = Date;
const PARK = RealDate.UTC(2026, 8, 26, 23, 30, 0); // Sat Sep 26 2026 19:30 EDT
let clockOffsetMs = PARK - RealDate.now();
const drillNow = () => RealDate.now() + clockOffsetMs;
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(drillNow());
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return drillNow;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
const setClock = (utcMs: number) => { clockOffsetMs = utcMs - RealDate.now(); };

installNextStubs();
const fence = fenceFetch();

const BASE_DIR = path.join(REPO, "node_modules/.cache", `cap-baseline-${BASE}`);
function baseline(rel: string): string {
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const out = path.join(BASE_DIR, rel.replace(/[/[\]]/g, "_"));
  fs.writeFileSync(out, src.replace(/(["'])@\//g, `$1${REPO}/src/`));
  return out;
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { etAt } = await import("@/lib/datetime");
  const { setSession } = await import("@/lib/auth/session");
  const cap = await import("@/lib/capacity");
  const wl = await import("@/lib/editorWorkload");
  const actions = await import("@/app/people/capacity/actions");
  const { computePayroll } = await import("@/lib/payroll");
  const oldWl = (await import(baseline("src/lib/editorWorkload.ts"))) as typeof import("@/lib/editorWorkload");

  const et = (month: number, day: number, hour: number, minute = 0) =>
    etAt(`2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, hour, minute);

  // ---- the world -----------------------------------------------------------
  const client = await prisma.client.create({ data: { name: "Drill Agent" }, select: { id: true } });
  const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER", payPercent: 0.35, payFloor: 100 }, select: { id: true } });
  const johnTm = await prisma.teamMember.create({ data: { name: "John Mark", email: "john@drill.invalid", role: "EDITOR", payType: "MONTHLY_FLAT", monthlyPay: 1800 }, select: { id: true } });
  const kimTm = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@drill.invalid", role: "EDITOR", payType: "MONTHLY_FLAT", monthlyPay: 2500 }, select: { id: true } });
  const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Cabrera", email: "kyle-tm@drill.invalid", role: "MANAGER" }, select: { id: true } });
  const mkUser = (email: string, name: string, role: string, teamMemberId: string | null, editorKey: string | null = null) =>
    prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", teamMemberId, editorKey }, select: { id: true, email: true, name: true, role: true } });
  const kyle = await mkUser("kyle@drill.invalid", "Kyle Cabrera", "ADMIN", kyleTm.id);
  const kim = await mkUser("kim@drill.invalid", "Kim Miguel", "EDITOR", kimTm.id, "kim");
  const harrisonU = await mkUser("harrison@drill.invalid", "Harrison Wells", "PHOTOGRAPHER", harrison.id);
  type U = { id: string; email: string; name: string | null; role: string };
  const as = (u: U) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined });

  // Work on both desks, and a shoot for payroll to see.
  let seq = 0;
  const mkJob = async (street: string, editorId: string, due: Date) => {
    const p = await prisma.project.create({
      data: {
        title: `${street}, Royersford, PA`, clientId: client.id, status: "SHOT", aryeoOrderId: `drill-cap-${++seq}`,
        shootDate: et(9, 24, 10), photographerId: harrison.id, editorId, editorManual: true, deliveryDue: due, promisedDueAt: due,
        payableInvoice: 400,
        statusEvidence: JSON.stringify({ present: ["Photos"], missing: ["Video"], dropbox: { rawVideo: 10, rawPhotos: 30, finalVideo: 0 } }),
      },
      select: { id: true },
    });
    await prisma.orderItem.create({ data: { projectId: p.id, title: "Standard Social Reel" } });
    await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1, status: "UPLOADED", uploadedAt: new Date() } });
    return p.id;
  };
  const j1 = await mkJob("1 Ash St", johnTm.id, et(9, 29, 12));
  await mkJob("2 Birch St", johnTm.id, et(10, 1, 12));
  await mkJob("3 Kestrel Ln", kimTm.id, et(9, 30, 12));
  const rows: import("@/lib/editorWorkload").WorkloadRow[] = [
    { status: "Ready for editing", editorKey: "john", editor: "John Mark", videos: 1, dueISO: et(9, 29, 12).toISOString(), late: false },
    { status: "Ready for editing", editorKey: "john", editor: "John Mark", videos: 1, dueISO: et(10, 1, 12).toISOString(), late: false },
    { status: "Ready for editing", editorKey: "kim", editor: "Kim Miguel", videos: 1, dueISO: et(9, 30, 12).toISOString(), late: false },
  ];
  const stripVolatile = (v: import("@/lib/editorWorkload").WorkloadView) => JSON.stringify({ ...v, capacity: undefined, measuredAt: undefined });
  const viewBefore = stripVolatile(await wl.editingWorkload(rows, { now: new Date() }));
  const payPeriod: [Date, Date] = [et(9, 1, 0), et(9, 30, 23, 59)];
  const payBefore = JSON.stringify(await computePayroll(...payPeriod));
  const stateSnapshot = async () =>
    JSON.stringify({
      projects: await prisma.project.findMany({ orderBy: { id: "asc" }, select: { id: true, editorId: true, status: true, deliveryDue: true, promisedDueAt: true, dueOverrideAt: true, priorityOverride: true } }),
      tasks: await prisma.smartTask.findMany({ orderBy: { id: "asc" }, select: { id: true, assignedKey: true, status: true, dueAt: true } }),
      pay: await prisma.teamMember.findMany({ orderBy: { email: "asc" }, select: { email: true, payType: true, monthlyPay: true, hourlyRate: true, payPercent: true, payFloor: true } }),
      entries: await prisma.payrollEntry.count(),
    });
  const state0 = await stateSnapshot();

  // =========================================================================
  c.head(`§0 · old code (${BASE}): an exception existed nowhere on the panel`);
  // =========================================================================
  {
    await prisma.capacityException.create({ data: { teamMemberId: johnTm.id, kind: "TIME_OFF", startsAt: et(9, 26, 0), endsAt: et(9, 28, 0), recordedBy: "seeded" } });
    const old = await oldWl.editingWorkload(rows, { now: new Date() });
    c.ok("the old panel had no capacity at all — John's time off today was invisible", !("capacity" in old) && old.editors.some((e) => e.key === "john"));
    const now = await wl.editingWorkload(rows, { now: new Date() });
    c.ok("the new panel carries it beside John", now.capacity?.john?.now.length === 1 && now.capacity.john.now[0].label === "Time off");
    await prisma.capacityException.deleteMany({}); // the drill's own seed, not a user's record
  }

  // =========================================================================
  c.head("§1 · the shape and the permission rule");
  // =========================================================================
  {
    const v = (o: Partial<import("@/lib/capacity").CapacityInput>) => cap.validateCapacity({ teamMemberId: johnTm.id, kind: "TIME_OFF", startsAt: et(10, 1, 9), ...o });
    c.ok("a plain entry passes; an open end is allowed", v({}).ok && v({ endsAt: null }).ok);
    c.ok("an unknown kind, an end before the start, a 91-day span and a 301-char note are refused",
      !v({ kind: "VACATION" }).ok && !v({ endsAt: et(9, 30, 9) }).ok && !v({ endsAt: et(12, 31, 9) }).ok && !v({ note: "x".repeat(301) }).ok);
    const may = (actor: import("@/lib/capacity").CapacityActor, teamMemberId: string, kind: import("@/lib/capacity").CapacityKind) =>
      cap.mayRecordCapacity(actor, { teamMemberId, kind }, { authEnforced: true }).ok;
    const office = { name: "Kyle", realRole: "ADMIN", teamMemberId: kyleTm.id, impersonating: false };
    const owner = { name: "Jordan", realRole: "OWNER", teamMemberId: null, impersonating: false };
    const kimA = { name: "Kim", realRole: "EDITOR", teamMemberId: kimTm.id, impersonating: false };
    const harrisonA = { name: "Harrison", realRole: "PHOTOGRAPHER", teamMemberId: harrison.id, impersonating: false };
    c.ok("owner and office: anything, for anyone", may(office, johnTm.id, "TIME_OFF") && may(owner, kimTm.id, "TRAINING") && may(office, kyleTm.id, "OTHER"));
    c.ok("an editor: their own offline or blocked", may(kimA, kimTm.id, "CONNECTIVITY") && may(kimA, kimTm.id, "BLOCKED"));
    c.ok("an editor: not their own time off or training, and nothing for anybody else",
      !may(kimA, kimTm.id, "TIME_OFF") && !may(kimA, kimTm.id, "TRAINING") && !may(kimA, johnTm.id, "CONNECTIVITY"));
    c.ok("a photographer, a previewing owner, and no session (auth on) are refused",
      !may(harrisonA, harrison.id, "BLOCKED") && !may({ ...owner, impersonating: true }, johnTm.id, "TIME_OFF") && !may(null, johnTm.id, "TIME_OFF"));
  }

  // =========================================================================
  c.head("§2 · recording through the real actions");
  // =========================================================================
  let johnOff = "";
  {
    await as(kyle);
    const r1 = await actions.recordCapacityExceptionAction({ teamMemberId: johnTm.id, kind: "TIME_OFF", startsAt: et(10, 1, 0).toISOString(), endsAt: et(10, 3, 0).toISOString(), note: "Family event" });
    c.ok("Kyle records John out Thu–Fri", r1.ok && /John Mark — time off Thu, Oct 1 – Fri, Oct 2/.test(r1.message), r1.message);
    johnOff = (await prisma.capacityException.findFirst({ where: { teamMemberId: johnTm.id }, select: { id: true } }))!.id;
    const row = await prisma.capacityException.findUnique({ where: { id: johnOff } });
    c.ok("…recorded by Kyle, with his note", row?.recordedBy === "Kyle Cabrera" && row.note === "Family event" && row.cancelledAt === null);

    await as(kim);
    const bell0 = await prisma.notification.count();
    const r2 = await actions.recordCapacityExceptionAction({ teamMemberId: kimTm.id, kind: "CONNECTIVITY", startsAt: new Date().toISOString(), endsAt: et(9, 26, 22).toISOString(), note: "Brownout in our area" });
    c.ok("Kim records herself offline until 10 PM", r2.ok && /until 10:00 PM today/.test(r2.message), r2.message);
    const bells = await prisma.notification.findMany({ where: { kind: "capacity_exception" }, select: { audience: true, title: true } });
    c.ok("…and the office hears it on the bell (OWNER+ADMIN), nothing to a phone", (await prisma.notification.count()) === bell0 + 1 && bells.length === 1 && bells[0].audience.includes("ADMIN") && /Kim: offline/.test(bells[0].title) && (await prisma.pendingSms.count()) === 0, bells[0]?.title);
    const r3 = await actions.recordCapacityExceptionAction({ teamMemberId: kimTm.id, kind: "TIME_OFF", startsAt: et(10, 5, 0).toISOString() });
    c.ok("Kim cannot book her own time off here", !r3.ok && /Tell Jordan or Kyle/.test(r3.message), r3.message);
    const r4 = await actions.recordCapacityExceptionAction({ teamMemberId: johnTm.id, kind: "BLOCKED", startsAt: new Date().toISOString() });
    c.ok("…nor record anything for John", !r4.ok && /only record your own/.test(r4.message));
    await as(harrisonU);
    const r5 = await actions.recordCapacityExceptionAction({ teamMemberId: harrison.id, kind: "BLOCKED", startsAt: new Date().toISOString() });
    c.ok("a photographer is refused", !r5.ok);
    c.ok("three refusals wrote nothing", (await prisma.capacityException.count()) === 2);
  }

  // =========================================================================
  c.head("§3 · chips on the workload panel");
  // =========================================================================
  {
    const view = await wl.editingWorkload(rows, { now: new Date() });
    const kimCap = view.capacity?.kim;
    const johnCap = view.capacity?.john;
    c.ok("Kim: offline NOW, until 10 PM", kimCap?.now.length === 1 && kimCap.now[0].label === "Offline" && /until 10:00 PM today/.test(kimCap.now[0].when) && kimCap.next7d.length === 0, kimCap?.now[0]?.when);
    c.ok("John: time off coming up this week, not now", johnCap?.now.length === 0 && johnCap.next7d.length === 1 && johnCap.next7d[0].when === "Thu, Oct 1 – Fri, Oct 2", johnCap?.next7d[0]?.when);
    c.ok("words, never hours: a same-day block, a started open-ended entry and a whole day read as people say them",
      cap.spanWords(et(9, 29, 14), et(9, 29, 16), new Date()) === "Tue, Sep 29, 2:00 PM–4:00 PM" &&
        cap.spanWords(et(9, 25, 9), null, new Date()) === "since Fri, Sep 25, no end set" &&
        cap.spanWords(et(9, 30, 0), et(10, 1, 0), new Date()) === "Wed, Sep 30, all day" &&
        cap.spanWords(et(9, 26, 0), et(9, 28, 0), new Date()) === "through Sun, Sep 27",
      [cap.spanWords(et(9, 29, 14), et(9, 29, 16), new Date()), cap.spanWords(et(9, 26, 0), et(9, 28, 0), new Date())].join(" | "));
    c.ok("each shows only on its own editor", !view.capacity?.john?.now.some((x) => x.label === "Offline") && !view.capacity?.kim?.next7d.some((x) => x.label === "Time off"));
    const kimOnly = await wl.editingWorkload(rows.filter((r) => r.editorKey === "kim"), { now: new Date() });
    c.ok("Kim's own scoped panel carries only hers", Object.keys(kimOnly.capacity ?? {}).join(",") === "kim");
    const reg = await cap.capacityRegister({ onlyTeamMemberId: kimTm.id });
    c.ok("the register scoped to Kim lists only Kim", reg.length === 1 && reg[0].person === "Kim Miguel" && reg[0].state === "now");
    const imp = await wl.priorityImpact(j1, { dueAt: et(9, 28, 9).toISOString() });
    c.ok("a rush preview on John's desk cites his time off — internally", imp.editorOut.some((s) => /John Mark: time off Thu, Oct 1 – Fri, Oct 2/.test(s)), imp.editorOut.join(" · "));
  }

  // =========================================================================
  c.head("§4 · it ends on its own; a cancel is a cancel");
  // =========================================================================
  {
    setClock(et(9, 26, 22, 5).getTime());
    const view = await wl.editingWorkload(rows, { now: new Date() });
    c.ok("after 10 PM Kim's chip is gone — nothing had to expire it", !view.capacity?.kim, JSON.stringify(view.capacity?.kim ?? null));
    await as(kim);
    const r0 = await actions.cancelCapacityExceptionAction(johnOff);
    c.ok("Kim cannot cancel John's time off", !r0.ok);
    await as(kyle);
    const r1 = await actions.cancelCapacityExceptionAction(johnOff);
    const r2 = await actions.cancelCapacityExceptionAction(johnOff);
    const row = await prisma.capacityException.findUnique({ where: { id: johnOff } });
    c.ok("Kyle cancels it once; a second press says so; the row is kept with who cancelled", r1.ok && r1.message === "Cancelled." && r2.ok && r2.message === "Already cancelled." && !!row?.cancelledAt && row.cancelledBy === "Kyle Cabrera");
    const after = await wl.editingWorkload(rows, { now: new Date() });
    c.ok("…and John's chip is gone", !after.capacity?.john);
    const reg = await cap.capacityRegister();
    c.ok("the register still shows both, as ended and cancelled", reg.find((r) => r.id === johnOff)?.state === "cancelled" && reg.some((r) => r.person === "Kim Miguel" && r.state === "ended"));
  }

  // =========================================================================
  c.head("§5 · byte-identical: the arithmetic, the queue and payroll");
  // =========================================================================
  {
    setClock(PARK);
    // Put one live exception back so "with" is really with.
    await prisma.capacityException.create({ data: { teamMemberId: johnTm.id, kind: "TRAINING", startsAt: et(9, 26, 0), endsAt: et(9, 27, 0), recordedBy: "Kyle Cabrera", note: "Protected training block" } });
    const withView = await wl.editingWorkload(rows, { now: new Date() });
    c.ok("with an exception in force, the panel carries it…", withView.capacity?.john?.now.length === 1);
    c.ok("…and lanes, rates, weeks-of-work, overdue and totals are byte-identical to before any exception existed", stripVolatile(withView) === viewBefore);
    c.ok("payroll for the month is byte-identical", JSON.stringify(await computePayroll(...payPeriod)) === payBefore);
    c.ok("no job was reassigned, no date moved, no task touched, no pay field changed", (await stateSnapshot()) === state0);
  }

  // =========================================================================
  c.head("§6 · fences");
  // =========================================================================
  c.ok("no outbound call left the building", fence.blocked.length === 0, fence.blocked.join(", "));
  c.ok("no text was queued", (await prisma.pendingSms.count()) === 0);
  void HOUR;

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
