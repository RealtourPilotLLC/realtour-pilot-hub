// ---------------------------------------------------------------------------
// DRILL PRIORITY-IMPACT: what a rush pushes back, and who may approve it
// (§10 priority/rush + AU-24, B4/G1/A3). Unified handoff, batch 5, Sep 26 2026.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/priority-impact.ts
//
// Drives the SHIPPED code against an isolated PGlite on 127.0.0.1:5787 (or
// DRILL_PORT), and saveEditOverrides as it was at 17df024 (never HEAD) for
// the old behaviour. Production is never opened; every outbound call is
// fenced and the model is intercepted (it must never be called).
//
// Jordan, Sep 25-26: "James and Kyle - James is the creative manager now. Also
// It can be escalated to me." James (review seat PRIMARY) or Kyle (BACKUP)
// approve a change that displaces other jobs, after seeing them; Jordan is the
// escalation and may always decide. Never the creative-manager flag.
//
//   §0  old code (17df024): any office login pulled a date ahead, silently
//   §1  the fold, with no database: displaced, slack, lanes, other editors
//   §2  priorityImpact on real rows: the two jobs pushed back, promises, risk
//   §3  who may approve: seats, owner, a refused admin, the flag, no seats
//   §4  the save: refused → must look → stale list → approved and recorded;
//       the promise never re-pinned, other editors untouched, no pay effect
//   §5  priority alone: "flagged above" the jobs due sooner
//   §6  paid rush vs faster than paid for
//   §7  escalation to Jordan: one card, one bell, nothing changes; his save closes it
//   §8  nothing to displace: later dates, unassigned, in review, across DST
//   §9  fences
//
// THE CLOCK IS PINNED to Saturday Sep 26 2026, 7:30 PM ET.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5787);
const BASE = "17df024";
const REPO = path.resolve(__dirname, "../..");
const HOUR = 3_600_000;

// ---- the pinned clock ----------------------------------------------------
const RealDate = Date;
const PARK = RealDate.UTC(2026, 8, 26, 23, 30, 0); // Sat Sep 26 2026 19:30 EDT
const clockOffsetMs = PARK - RealDate.now();
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

installNextStubs();

let aiCalls = 0;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJson" && k !== "aiText") return t[k];
      return async () => { aiCalls++; throw new Error("drill: the model is not available"); };
    },
  }),
);
const fence = fenceFetch();

const BASE_DIR = path.join(REPO, "node_modules/.cache", `prio-baseline-${BASE}`);
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
  const { etAt, etDateTime } = await import("@/lib/datetime");
  const { putSetting } = await import("@/lib/settings");
  const { setSession } = await import("@/lib/auth/session");
  const { buildEditorQueue } = await import("@/lib/editorQueue");
  const wl = await import("@/lib/editorWorkload");
  const actions = await import("@/app/editing/actions");
  const oldActions = (await import(baseline("src/app/editing/actions.ts"))) as typeof import("@/app/editing/actions");

  const et = (month: number, day: number, hour: number, minute = 0) =>
    etAt(`2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, hour, minute);
  const same = (a: Date | null | undefined, b: Date | null | undefined) => !!a && !!b && a.getTime() === b.getTime();

  // ---- the world -----------------------------------------------------------
  const client = await prisma.client.create({ data: { name: "Drill Agent" }, select: { id: true } });
  const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
  const johnTm = await prisma.teamMember.create({ data: { name: "John Mark", email: "john@drill.invalid", role: "EDITOR", payType: "MONTHLY_FLAT", monthlyPay: 1800 }, select: { id: true } });
  const kimTm = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@drill.invalid", role: "EDITOR", payType: "MONTHLY_FLAT", monthlyPay: 2500 }, select: { id: true } });
  const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Cabrera", email: "kyle-tm@drill.invalid", role: "MANAGER", payType: "HOURLY", hourlyRate: 20 }, select: { id: true, name: true } });
  const jamesTm = await prisma.teamMember.create({ data: { name: "James Porter", email: "james-tm@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true, name: true } });
  const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan-tm@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true, name: true } });
  // An office login with NO review seat — and, in §3, the creative-manager flag.
  const tempTm = await prisma.teamMember.create({ data: { name: "Tess Office", email: "tess-tm@drill.invalid", role: "MANAGER" }, select: { id: true } });
  const mkUser = (email: string, name: string, role: string, teamMemberId: string) =>
    prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", teamMemberId }, select: { id: true, email: true, name: true, role: true } });
  const jordan = await mkUser("jordan@drill.invalid", "Jordan Spackman", "OWNER", jordanTm.id);
  const kyle = await mkUser("kyle@drill.invalid", "Kyle Cabrera", "ADMIN", kyleTm.id);
  const james = await mkUser("james@drill.invalid", "James Porter", "ADMIN", jamesTm.id);
  const tess = await mkUser("tess@drill.invalid", "Tess Office", "ADMIN", tempTm.id);
  type U = { id: string; email: string; name: string | null; role: string };
  const as = (u: U) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined });
  const seats = { creativeApproverTeamMemberId: jamesTm.id, backupReviewerTeamMemberId: kyleTm.id, fallbackReviewerTeamMemberId: jordanTm.id };
  await putSetting("review_room", seats);

  let seq = 0;
  const mkJob = async (o: { street: string; editorId: string | null; due: Date; status?: "SHOT" | "EDITING" | "REVIEW"; items?: string[] }) => {
    const shootDate = et(9, 22, 10);
    const p = await prisma.project.create({
      data: {
        title: `${o.street}, Royersford, PA`, clientId: client.id, status: o.status ?? "SHOT", aryeoOrderId: `drill-prio-${++seq}`,
        shootDate, photographerId: harrison.id, editorId: o.editorId, editorManual: true,
        deliveryDue: o.due, promisedDueAt: o.due, promisedPinnedAt: et(9, 22, 12),
        statusEvidence: JSON.stringify({ present: ["Photos"], missing: ["Video"], dropbox: { rawVideo: 12, rawPhotos: 40, finalVideo: 0 } }),
      },
      select: { id: true },
    });
    for (const t of o.items ?? ["Standard Social Reel"]) await prisma.orderItem.create({ data: { projectId: p.id, title: t } });
    await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1, status: "UPLOADED", uploadedAt: new Date() } });
    return { id: p.id, street: o.street };
  };
  // John's desk: A due tomorrow evening (inside a day), B Tuesday, C Thursday.
  const A = await mkJob({ street: "1 Ash St", editorId: johnTm.id, due: et(9, 27, 18) });
  const B = await mkJob({ street: "2 Birch St", editorId: johnTm.id, due: et(9, 29, 12) });
  const C = await mkJob({ street: "3 Cedar St", editorId: johnTm.id, due: et(10, 1, 17) });
  // Kim's desk, which no change on John's may touch.
  const K1 = await mkJob({ street: "10 Kestrel Ln", editorId: kimTm.id, due: et(9, 28, 9) });
  const K2 = await mkJob({ street: "11 Kestrel Ln", editorId: kimTm.id, due: et(9, 30, 9) });
  // For the old-code demonstration only: its own job, reset afterwards.
  const D = await mkJob({ street: "4 Dogwood St", editorId: johnTm.id, due: et(10, 2, 17) });

  const deskOrder = async (editorKey: string) => (await buildEditorQueue()).notDone.filter((r) => r.editorKey === editorKey).map((r) => r.street);
  const payrollSnapshot = async () =>
    JSON.stringify({
      entries: await prisma.payrollEntry.count(),
      team: await prisma.teamMember.findMany({ orderBy: { email: "asc" }, select: { email: true, payType: true, monthlyPay: true, hourlyRate: true, payPercent: true, payFloor: true, mileageRate: true } }),
    });
  const pay0 = await payrollSnapshot();
  const activities = (projectId: string) => prisma.activity.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { body: true } });

  // =========================================================================
  c.head(`§0 · old code (${BASE}): any office login pulled a date ahead, and nothing said what it cost`);
  // =========================================================================
  {
    await as(tess);
    const r = await oldActions.saveEditOverrides(D.id, { dueAt: et(9, 27, 9).toISOString() });
    const acts = await activities(D.id);
    c.ok("Tess (an office login with no review seat) moved 4 Dogwood St ahead of John's whole desk — accepted", r.ok, r.message);
    c.ok("…and the timeline line names no approver, no displaced job and no reason", acts.length === 1 && !/rush|ahead of|Why/i.test(acts[0].body), acts[0]?.body);
    await prisma.project.update({ where: { id: D.id }, data: { dueOverrideAt: null, overrideBy: null, overrideAt: null, overrideNote: null } });
    await prisma.project.update({ where: { id: D.id }, data: { status: "CANCELLED" } }); // off the board for the rest
  }

  // =========================================================================
  c.head("§1 · the fold, with no database");
  // =========================================================================
  {
    const now = new Date();
    const row = (id: string, editorKey: string | null, due: Date | null, status = "Ready for editing", priority = "NORMAL") => ({
      id, street: id, client: "X", editorKey, editor: editorKey, status, dueISO: due?.toISOString() ?? null, shootISO: "2026-09-22", priority,
    });
    const rows = [
      row("a", "john", et(9, 27, 18)),
      row("b", "john", et(9, 29, 12)),
      row("c", "john", et(10, 1, 17)),
      row("k", "kim", et(9, 28, 9)),
      row("r", "john", et(9, 28, 9), "Ready for review"),
    ];
    const f = wl.foldPriorityImpact(rows, "c", { dueISO: et(9, 27, 12).toISOString(), priority: "NORMAL" }, now);
    c.ok("pulling the third job to Sunday noon displaces the two ahead of it, in order", f.displaced.map((d) => d.projectId).join(",") === "a,b", f.displaced.map((d) => d.projectId).join(","));
    const a = f.displaced.find((d) => d.projectId === "a");
    c.ok("…with whole hours left from now (Sat 7:30 PM → Sun 6 PM = 22½ → 22) and the one inside a day flagged at risk", a?.slackHours === 22 && a.atRisk === true && f.displaced.find((d) => d.projectId === "b")?.atRisk === false, `a ${a?.slackHours}h`);
    c.ok("Kim's job and John's job in review are never in the answer", !f.displaced.some((d) => d.projectId === "k" || d.projectId === "r"));
    const mid = wl.foldPriorityImpact(rows, "c", { dueISO: et(9, 28, 12).toISOString(), priority: "NORMAL" }, now);
    c.ok("pulling it only to Monday noon passes B alone", mid.displaced.map((d) => d.projectId).join(",") === "b");
    const later = wl.foldPriorityImpact(rows, "a", { dueISO: et(10, 5, 12).toISOString(), priority: "NORMAL" }, now);
    c.ok("moving a job LATER displaces nobody", later.displaced.length === 0);
    c.ok("mayDisplace: earlier date or higher priority yes; later date or lower priority no",
      wl.mayDisplace({ dueISO: et(10, 1, 17).toISOString(), priority: "NORMAL" }, { dueISO: et(9, 27, 12).toISOString(), priority: "NORMAL" }) &&
      wl.mayDisplace({ dueISO: null, priority: "NORMAL" }, { dueISO: null, priority: "URGENT" }) &&
      !wl.mayDisplace({ dueISO: et(9, 27, 12).toISOString(), priority: "HIGH" }, { dueISO: et(10, 1, 17).toISOString(), priority: "LOW" }));
    const prio = wl.foldPriorityImpact(rows, "c", { dueISO: et(10, 1, 17).toISOString(), priority: "URGENT" }, now);
    c.ok("a priority raise alone flags it above the jobs due sooner, marked 'priority'", prio.displaced.map((d) => `${d.projectId}:${d.why}`).join(",") === "a:priority,b:priority");
    const toKimNoon = wl.foldPriorityImpact(rows, "c", { dueISO: et(9, 28, 12).toISOString(), priority: "NORMAL", editorKey: "kim" }, now);
    const toKimEarly = wl.foldPriorityImpact(rows, "c", { dueISO: et(9, 28, 8).toISOString(), priority: "NORMAL", editorKey: "kim" }, now);
    c.ok("handed to Kim in the same save, it is measured against KIM's desk: Monday noon passes nothing of hers, Monday 8 AM passes her 9 AM job — and none of John's",
      toKimNoon.displaced.length === 0 && toKimEarly.displaced.map((d) => d.projectId).join(",") === "k",
      `${JSON.stringify(toKimNoon.displaced.map((d) => d.projectId))} / ${JSON.stringify(toKimEarly.displaced.map((d) => d.projectId))}`);
    const unassigned = wl.foldPriorityImpact([...rows, row("u", null, et(10, 3, 9))], "u", { dueISO: et(9, 27, 9).toISOString(), priority: "NORMAL" }, now);
    c.ok("an unassigned job displaces nobody, and says why", unassigned.displaced.length === 0 && /No editor/.test(unassigned.note ?? ""), unassigned.note ?? "");
    const inReview = wl.foldPriorityImpact(rows, "r", { dueISO: et(9, 27, 9).toISOString(), priority: "URGENT" }, now);
    c.ok("a job waiting on a verdict displaces nobody on the editor's desk", inReview.displaced.length === 0 && /office/.test(inReview.note ?? ""));
  }

  // =========================================================================
  c.head("§2 · priorityImpact on real rows");
  // =========================================================================
  const pullC = et(9, 27, 12).toISOString();
  {
    const imp = await wl.priorityImpact(C.id, { dueAt: pullC });
    c.ok("3 Cedar St to Sunday noon: pushes back 1 Ash St and 2 Birch St on John Mark's desk", imp.displaced.map((d) => d.street).join(",") === "1 Ash St,2 Birch St" && imp.editorName === "John Mark", imp.sentence);
    const ash = imp.displaced[0];
    c.ok("each carries its pinned promise and slack; Ash is due inside a day", same(ash.promiseISO ? new Date(ash.promiseISO) : null, et(9, 27, 18)) && ash.atRisk && ash.slackHours === 22);
    c.ok("the sentence names them with promises in ET", /moves ahead of 2 of John Mark's jobs — 1 Ash St \(promised Sun, Sep 27, 6:00 PM ET; due inside a day\), 2 Birch St \(promised Tue, Sep 29, 12:00 PM ET\)/.test(imp.sentence), imp.sentence);
    c.ok("this job's own promise is reported and the new date is faster than it (no rush on the order)", same(imp.promiseISO ? new Date(imp.promiseISO) : null, et(10, 1, 17)) && imp.fasterThanPromise && !imp.paidRush);
    c.ok("read-only: nothing on any job changed", (await prisma.project.count({ where: { OR: [{ dueOverrideAt: { not: null } }, { priorityOverride: { not: null } }] } })) === 0);
  }

  // =========================================================================
  c.head("§3 · who may approve");
  // =========================================================================
  {
    const me = (u: U, tm: string) => ({ realRole: u.role, teamMemberId: tm, impersonating: false, status: "ACTIVE" });
    const aJames = await wl.rushAuthority(me(james, jamesTm.id), { authEnforced: true });
    const aKyle = await wl.rushAuthority(me(kyle, kyleTm.id), { authEnforced: true });
    const aJordan = await wl.rushAuthority(me(jordan, jordanTm.id), { authEnforced: true });
    const aTess = await wl.rushAuthority(me(tess, tempTm.id), { authEnforced: true });
    c.ok("James approves as the creative manager (PRIMARY seat)", aJames.may && aJames.as === "PRIMARY");
    c.ok("Kyle approves as the review backup", aKyle.may && aKyle.as === "BACKUP");
    c.ok("Jordan may always decide — he is the escalation", aJordan.may && aJordan.as === "OWNER" && aJordan.escalateTo === "Jordan Spackman");
    c.ok("an office login with no seat is refused, told who can and who to send it to", !aTess.may && /James or Kyle/.test(aTess.why ?? "") && /Jordan/.test(aTess.why ?? ""), aTess.why ?? "");
    await prisma.teamMember.update({ where: { id: tempTm.id }, data: { creativeManager: true } });
    const aFlag = await wl.rushAuthority(me(tess, tempTm.id), { authEnforced: true });
    c.ok("the creative-manager flag grants nothing", !aFlag.may);
    await prisma.teamMember.update({ where: { id: tempTm.id }, data: { creativeManager: false } });
    const aPreview = await wl.rushAuthority({ ...me(jordan, jordanTm.id), impersonating: true }, { authEnforced: true });
    c.ok("never while previewing as someone else", !aPreview.may);
    await putSetting("review_room", { creativeApproverTeamMemberId: null, backupReviewerTeamMemberId: null, fallbackReviewerTeamMemberId: null });
    const aNone = await wl.rushAuthority(me(tess, tempTm.id), { authEnforced: true });
    c.ok("no seats named: the office's existing authority stands (and says the seats are unset)", aNone.may && !aNone.seatsNamed);
    await putSetting("review_room", seats);
  }

  // =========================================================================
  c.head("§4 · the save: refused, look first, stale list, then approved and recorded");
  // =========================================================================
  const kimBefore = await deskOrder("kim");
  {
    await as(tess);
    const r1 = await actions.saveEditOverrides(C.id, { dueAt: pullC });
    const c1 = await prisma.project.findUnique({ where: { id: C.id }, select: { dueOverrideAt: true } });
    c.ok("Tess is refused, told James or Kyle — and shown the two jobs", !r1.ok && /James or Kyle/.test(r1.message) && r1.rush?.impact.displaced.length === 2, r1.message);
    c.ok("…and nothing was written", c1?.dueOverrideAt === null && (await activities(C.id)).length === 0);

    await as(kyle);
    const r2 = await actions.saveEditOverrides(C.id, { dueAt: pullC });
    c.ok("Kyle without looking: refused, asked to look and say why", !r2.ok && /Look at them and say why/.test(r2.message) && r2.rush?.authority.as === "BACKUP", r2.message);
    const r3 = await actions.saveEditOverrides(C.id, { dueAt: pullC }, { seen: [A.id], reason: "Agent's listing goes live Monday" });
    c.ok("Kyle with a stale list (he saw one of the two): refused, 'the queue changed'", !r3.ok && /queue changed/.test(r3.message), r3.message);
    c.ok("…still nothing written", (await prisma.project.findUnique({ where: { id: C.id }, select: { dueOverrideAt: true } }))?.dueOverrideAt === null && (await activities(C.id)).length === 0);

    const r4 = await actions.saveEditOverrides(C.id, { dueAt: pullC }, { seen: [A.id, B.id], reason: "Agent's listing goes live Monday" });
    const c4 = await prisma.project.findUnique({ where: { id: C.id }, select: { dueOverrideAt: true, promisedDueAt: true, overrideBy: true } });
    const acts = await activities(C.id);
    c.ok("Kyle, having looked, with a reason: saved", r4.ok && same(c4?.dueOverrideAt, new Date(pullC)), r4.message);
    c.ok("the promise the client was sold is NOT re-pinned", same(c4?.promisedDueAt, et(10, 1, 17)));
    c.ok("ONE timeline line: who approved (and from which seat), what it pushed back, faster than paid for, and why",
      acts.length === 1 && /rush approved by Kyle Cabrera \(review backup\): it moves ahead of 2 of John Mark's jobs — 1 Ash St/.test(acts[0].body) &&
        /Faster than the client paid for\./.test(acts[0].body) && /Why: “Agent's listing goes live Monday”/.test(acts[0].body),
      acts[0]?.body);
    c.ok("John's desk now reads Cedar first; the queue's own order did the moving", (await deskOrder("john")).join(",") === "3 Cedar St,1 Ash St,2 Birch St", (await deskOrder("john")).join(","));
    c.ok("Kim's desk is exactly as it was", (await deskOrder("kim")).join(",") === kimBefore.join(","), kimBefore.join(","));
    const r5 = await actions.saveEditOverrides(C.id, { dueAt: pullC }, { seen: [A.id, B.id], reason: "again" });
    c.ok("the same save again: 'Nothing changed', no second line", r5.ok && r5.message === "Nothing changed." && (await activities(C.id)).length === 1);
    c.ok("no pay effect: payroll rows and every pay field identical", (await payrollSnapshot()) === pay0);
  }

  // =========================================================================
  c.head("§5 · priority alone: flagged above the jobs due sooner");
  // =========================================================================
  {
    await as(tess);
    const r1 = await actions.saveEditOverrides(B.id, { priority: "URGENT" });
    c.ok("Tess raising 2 Birch St to URGENT is refused — it would be done ahead of two jobs due sooner", !r1.ok && r1.rush?.impact.displaced.map((d) => `${d.street}:${d.why}`).join(",") === "3 Cedar St:priority,1 Ash St:priority", r1.rush?.impact.sentence);
    await as(james);
    const r2 = await actions.saveEditOverrides(B.id, { priority: "URGENT" }, { seen: r1.rush!.impact.displaced.map((d) => d.projectId), reason: "Client closing Tuesday" });
    const acts = await activities(B.id);
    c.ok("James approves it as the creative manager; the line says 'flagged above'", r2.ok && /rush approved by James Porter \(creative manager\): it is flagged above 2 of John Mark's jobs due sooner/.test(acts.slice(-1)[0]?.body ?? ""), acts.slice(-1)[0]?.body);
    c.ok("priority does not reorder the queue (by due date, as before)", (await deskOrder("john")).join(",") === "3 Cedar St,1 Ash St,2 Birch St");
  }

  // =========================================================================
  c.head("§6 · a paid rush is not 'faster than paid for'");
  // =========================================================================
  {
    const R = await mkJob({ street: "5 Rowan St", editorId: kimTm.id, due: et(10, 3, 17), items: ["Standard Social Reel", "Same Day Video Delivery"] });
    const imp = await wl.priorityImpact(R.id, { dueAt: et(9, 28, 8).toISOString() });
    c.ok("a same-day line on the order reads as paid; it still shows what it pushes back", imp.paidRush && imp.fasterThanPromise && imp.displaced.length === 2, imp.sentence);
    await as(kyle);
    const r = await actions.saveEditOverrides(R.id, { dueAt: et(9, 28, 8).toISOString() }, { seen: imp.displaced.map((d) => d.projectId), reason: "Paid same-day" });
    const line = (await activities(R.id)).slice(-1)[0]?.body ?? "";
    c.ok("saved by Kyle with no 'faster than paid for' on the line", r.ok && !/Faster than the client paid for/.test(line) && /rush approved by Kyle/.test(line), line);
  }

  // =========================================================================
  c.head("§7 · escalation to Jordan");
  // =========================================================================
  {
    await as(tess);
    const want = { dueAt: et(9, 27, 9).toISOString() };
    const bell0 = await prisma.notification.count();
    const sms0 = await prisma.pendingSms.count();
    const e1 = await actions.escalateRushToJordan(A.id, want, "Seller moved the open house to Sunday");
    const card = await prisma.smartTask.findUnique({ where: { dedupeKey: `rush-approval:${A.id}` } });
    c.ok("Tess sends it to Jordan: one card on his list, flagged by her, with the list and the reason", e1.ok && card?.status === "OPEN" && card.assignedKey === "jordan" && card.ownerId === jordanTm.id && card.flaggedBy === "Tess Office" && /Seller moved the open house/.test(card.summary ?? "") && /moves ahead of/.test(card.summary ?? ""), e1.message);
    const a1 = await prisma.project.findUnique({ where: { id: A.id }, select: { dueOverrideAt: true } });
    c.ok("…nothing on the job changed", a1?.dueOverrideAt === null);
    const bells = await prisma.notification.findMany({ where: { kind: "rush_approval" }, select: { audience: true, userKey: true } });
    c.ok("…one bell row for the owner, and nothing to a phone", (await prisma.notification.count()) === bell0 + 1 && bells.length === 1 && bells[0].audience.includes("OWNER") && (await prisma.pendingSms.count()) === sms0);
    const e2 = await actions.escalateRushToJordan(A.id, want, "Seller moved the open house to Sunday — confirmed");
    c.ok("asking again updates the same card", e2.ok && (await prisma.smartTask.count({ where: { taskType: "rush_approval", projectId: A.id } })) === 1);
    const e3 = await actions.escalateRushToJordan(A.id, want, "");
    c.ok("an escalation needs a reason", !e3.ok && /Say why/.test(e3.message));
    await as(jordan);
    const e4 = await actions.escalateRushToJordan(A.id, want, "x");
    c.ok("Jordan cannot escalate to himself — he approves it", !e4.ok && /approve it yourself/.test(e4.message));
    const imp = await wl.priorityImpact(A.id, want);
    const r = await actions.saveEditOverrides(A.id, want, { seen: imp.displaced.map((d) => d.projectId), reason: "Approved — open house" });
    const card2 = await prisma.smartTask.findUnique({ where: { dedupeKey: `rush-approval:${A.id}` } });
    const own = await actions.saveEditOverrides(B.id, { dueAt: et(9, 27, 8).toISOString() });
    const ownLine = (await activities(B.id)).slice(-1)[0]?.body ?? "";
    c.ok("Jordan is never made to fill the form: his own save with no list and no reason is approved and still recorded", own.ok && /rush approved by Jordan Spackman: it moves ahead of/.test(ownLine) && !/Why:/.test(ownLine), ownLine);
    c.ok("Jordan saves the change himself: approved, and his card closes", r.ok && card2?.status === "COMPLETED" && /rush approved by Jordan Spackman: it moves ahead of 1 of John Mark's jobs — 3 Cedar St \(due Sun, Sep 27, 12:00 PM ET, promised Thu, Oct 1, 5:00 PM ET; due inside a day\)/.test((await activities(A.id)).slice(-1)[0]?.body ?? ""), (await activities(A.id)).slice(-1)[0]?.body);
  }

  // =========================================================================
  c.head("§8 · nothing to displace — no gate");
  // =========================================================================
  {
    await as(tess);
    const later = await actions.saveEditOverrides(K2.id, { dueAt: et(10, 6, 12).toISOString() });
    c.ok("Tess moving a job LATER is not a rush: saved, no approval asked", later.ok && !/rush/.test((await activities(K2.id)).slice(-1)[0]?.body ?? ""), later.message);
    const U = await mkJob({ street: "6 Unset Way", editorId: null, due: et(10, 5, 12) });
    await prisma.project.update({ where: { id: U.id }, data: { editorManual: true } });
    const imp = await wl.priorityImpact(U.id, { dueAt: et(9, 27, 8).toISOString() });
    c.ok("a job pinned to no editor displaces nobody, and says why", imp.displaced.length === 0 && imp.editorKey === null && /No editor/.test(imp.note ?? ""), imp.note ?? imp.sentence);
    const dst = await wl.priorityImpact(K1.id, { dueAt: et(11, 2, 9).toISOString() });
    c.ok("across the Nov 1 clock change the date reads 9:00 AM ET (EST)", /Nov/.test(etDateTime(dst.after.dueISO)) && /9:00 AM/.test(etDateTime(dst.after.dueISO)) && dst.displaced.length === 0, etDateTime(dst.after.dueISO));
    void K1; void HOUR;
  }

  // =========================================================================
  c.head("§9 · fences");
  // =========================================================================
  c.ok("no outbound call left the building", fence.blocked.length === 0, fence.blocked.join(", "));
  c.ok("the model was never called", aiCalls === 0);
  c.ok("no text was queued anywhere", (await prisma.pendingSms.count()) === 0);

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
