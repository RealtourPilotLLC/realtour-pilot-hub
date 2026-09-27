// ---------------------------------------------------------------------------
// DRILL B4-REOPEN: reopened work has a clock (A52), and "Waiting on
// instructions" is one word on the queue, the card and the board (A32).
// Unified handoff, batch 4, Sep 25 2026.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/b4-reopen.ts
//
// Drives the SHIPPED code against an isolated PGlite on 127.0.0.1:5718 (or
// DRILL_PORT), and the same files as they were at fa9a2c9 (never HEAD) beside
// them wherever the old behaviour is observable. Production is never opened;
// the model is intercepted and counted (it must never be called), and every
// outbound call is fenced.
//
//   §1  the clock rules — §3's 24/48 weekday hours (DST week too) and
//       Jordan's same-day rule (weekday, after hours, weekend)
//   §2  a CLIENT round on a delivered job: board, brief, queue and the
//       revision card agree; the old queue called it late against the
//       delivery promise it had kept
//   §3  a portal addendum keeps its round's clock; a second ask never pushes
//       the job's date out
//   §4  the OFFICE reopens: a new cut queued on a finished job, Revisions on
//       the pill after hours — same business day, the edit card too
//   §5  a board move off Delivered: the hourly net dates it from the move
//   §6  history is never back-dated: an old reopen waits on Kyle's
//       exceptions, and a person dates it (MANUAL)
//   §7  an office date saved for the ORIGINAL work no longer calls a
//       reopened job late; one saved for the reopen still wins
//   §8  past due → late everywhere, and on Kyle's exceptions with its owner
//   §9  settle, then reopen again: the old clock is met, never inherited
//   §10 an extra shoot on a delivered job: the board lists it, with the same
//       date as the queue and the brief
//   §11 races and re-runs write one clock
//   §12 a job never delivered keeps its delivery promise
//   §13 the photographer KPI does not count an office reopen
//   §14 A32: an EDITING nobody confirmed reads "Waiting on instructions"
//   §15 the edit page's tracker says where the date came from
//   §16 fences: no model call, nothing left the building
//
// THE CLOCK IS PINNED to Friday Sep 25 2026, 14:00 ET, and moved by hand.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Module from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5718);
const BASE = "fa9a2c9";
const REPO = path.resolve(__dirname, "../..");
const DAY = 86_400_000;

// ---- the pinned clock ----------------------------------------------------
const RealDate = Date;
const PARK = RealDate.UTC(2026, 8, 25, 18, 0, 0); // Fri Sep 25 2026 14:00 EDT
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

// lucide-react builds a React context at import time, which the react-server
// build of React does not have; §15 walks the tracker's element tree and never
// renders an icon.
{
  const L = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = L._load;
  L._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : () => null) });
    if (request === "next/link") return { __esModule: true, default: () => null };
    return prev.call(this, request, parent, isMain);
  };
}

// The model must never be reached: every ask here is short, and an office
// reopen is written without one. Counted, and answered with nothing.
let aiCalls = 0;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJson") return t[k];
      return async () => { aiCalls++; throw new Error("drill: the model is not available"); };
    },
  }),
);
const fence = fenceFetch();

// ---- old code, pinned to BASE --------------------------------------------
const BASE_DIR = path.join(REPO, "node_modules/.cache", `b4r-baseline-${BASE}`);
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
  const board = await import("@/lib/deliveryBoard");
  const rb = await import("@/lib/revisionBrief");
  const { buildEditorQueue } = await import("@/lib/editorQueue");
  const { projectBrief } = await import("@/lib/projectBrief");
  const { opsExceptionsBoard } = await import("@/lib/opsExceptions");
  const { raiseRevision } = await import("@/lib/comms");
  const editingActions = await import("@/app/editing/actions");
  const appActions = await import("@/app/actions");
  const { scoreQuarter } = await import("@/lib/kpi");
  const { setSession } = await import("@/lib/auth/session");

  const oldBoard = (await import(baseline("src/lib/deliveryBoard.ts"))) as typeof import("@/lib/deliveryBoard");
  const oldQueue = (await import(baseline("src/lib/editorQueue.ts"))) as typeof import("@/lib/editorQueue");
  const oldBrief = (await import(baseline("src/lib/projectBrief.ts"))) as typeof import("@/lib/projectBrief");
  const oldKpi = (await import(baseline("src/lib/kpi.ts"))) as typeof import("@/lib/kpi");

  /** An ET wall-clock instant: et(9, 25, 14) = Sep 25 2026 2:00 PM ET. */
  const et = (month: number, day: number, hour: number, minute = 0) =>
    etAt(`2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, hour, minute);
  const exact = (a: Date | null | undefined, b: Date | null | undefined) => !!a && !!b && a.getTime() === b.getTime();
  // The pinned clock keeps ticking (a pass takes a few seconds), so an instant
  // the code took from `new Date()` lands within a minute of the wall time.
  const same = (a: Date | null | undefined, b: Date | null | undefined) => !!a && !!b && Math.abs(a.getTime() - b.getTime()) < 60_000;
  const sameISO = (iso: string | null | undefined, b: Date) => !!iso && same(new Date(iso), b);
  const show = (d: Date | null | undefined) => (d ? etDateTime(d) : "none");

  // ---- the world -----------------------------------------------------------
  const client = await prisma.client.create({ data: { name: "Drill Agent" }, select: { id: true } });
  const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
  const kimTm = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@drill.invalid", role: "EDITOR" }, select: { id: true } });
  await prisma.teamMember.create({ data: { name: "John Mark", email: "john@drill.invalid", role: "EDITOR" } });
  await prisma.teamMember.create({ data: { name: "Kyle Cabrera", email: "kyle-tm@drill.invalid", role: "MANAGER" } });
  const jordan = await prisma.appUser.create({ data: { email: "jordan@drill.invalid", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE" }, select: { id: true, email: true, name: true, role: true } });
  await setSession({ uid: jordan.id, email: jordan.email, role: jordan.role, name: jordan.name ?? undefined });

  let seq = 0;
  type Job = { id: string; street: string; deliverableId: string };
  const mkJob = async (o: {
    street: string;
    status: "SHOT" | "EDITING" | "REVIEW" | "REVISION" | "DELIVERED";
    deliveredAt?: Date | null;
    shootDate?: Date;
    revisionRequestedAt?: Date | null;
    dueOverrideAt?: Date | null;
    overrideAt?: Date | null;
    blocked?: string | null;
    delivered?: boolean;
  }): Promise<Job> => {
    const shootDate = o.shootDate ?? et(9, 14, 10);
    const p = await prisma.project.create({
      data: {
        title: `${o.street}, Royersford, PA`, clientId: client.id, status: o.status, aryeoOrderId: `drill-b4-${++seq}`,
        shootDate, photographerId: harrison.id, editorId: kimTm.id, editorManual: true,
        deliveredAt: o.deliveredAt ?? null,
        // The delivery promise the job KEPT — two days after the shoot.
        deliveryDue: new Date(shootDate.getTime() + 2 * DAY), promisedDueAt: new Date(shootDate.getTime() + 2 * DAY),
        revisionRequestedAt: o.revisionRequestedAt ?? null,
        dueOverrideAt: o.dueOverrideAt ?? null, overrideAt: o.overrideAt ?? null,
        handoffBlockedReason: o.blocked ?? null,
        statusEvidence: JSON.stringify(
          o.delivered === false
            ? { present: ["Photos"], missing: ["Video"], dropbox: { rawVideo: 12, rawPhotos: 40, finalVideo: 0 } }
            : { present: ["Photos", "Video"], missing: [], dropbox: { rawVideo: 12, rawPhotos: 40, finalVideo: 1 }, aryeo: { photos: 40, videos: 1 } },
        ),
      },
      select: { id: true },
    });
    await prisma.orderItem.create({ data: { projectId: p.id, title: "Standard Social Reel" } });
    const d = await prisma.deliverable.create({
      data: { projectId: p.id, type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1, status: o.delivered === false ? "UPLOADED" : "DONE", uploadedAt: new Date() },
      select: { id: true },
    });
    return { id: p.id, street: o.street, deliverableId: d.id };
  };
  const boardOf = async (id: string, b?: Awaited<ReturnType<typeof board.deliveryBoard>>) => {
    const bb = b ?? (await board.deliveryBoard());
    return [...bb.today, ...bb.tomorrow, ...bb.upcoming, ...bb.delivered].find((j) => j.id === id) ?? null;
  };
  const oldBoardOf = async (id: string) => {
    const bb = await oldBoard.deliveryBoard();
    return [...bb.today, ...bb.tomorrow, ...bb.upcoming, ...bb.delivered].find((j) => j.id === id) ?? null;
  };
  const rowOf = async (id: string) => {
    const q = await buildEditorQueue();
    return [...q.notDone, ...q.upcoming, ...q.done].find((r) => r.id === id) ?? null;
  };
  const oldRowOf = async (id: string) => {
    const q = await oldQueue.buildEditorQueue();
    return [...q.notDone, ...q.upcoming, ...q.done].find((r) => r.id === id) ?? null;
  };
  const exceptionOf = async (id: string) => (await opsExceptionsBoard({ now: new Date() })).rows.find((r) => r.id === `reopened:${id}`) ?? null;
  const officeBriefs = (projectId: string) => prisma.revisionBrief.count({ where: { projectId, source: "office" } });

  // =========================================================================
  c.head("§1 · the clock rules");
  // =========================================================================
  {
    const fri = board.clientRoundClock(et(9, 25, 14));
    c.ok("a client ask Friday 2 PM: target Monday 2 PM, due Tuesday 2 PM (24/48 hours of weekday time)", same(fri.targetAt, et(9, 28, 14)) && same(fri.dueAt, et(9, 29, 14)), `${show(fri.targetAt)} / ${show(fri.dueAt)}`);
    const mon = board.clientRoundClock(et(9, 28, 14, 30));
    c.ok("Monday 2:30 PM: target Tuesday 2:30 PM, due Wednesday 2:30 PM", same(mon.targetAt, et(9, 29, 14, 30)) && same(mon.dueAt, et(9, 30, 14, 30)), `${show(mon.targetAt)} / ${show(mon.dueAt)}`);
    const dst = board.clientRoundClock(et(10, 30, 14));
    c.ok("across the Nov 1 clock change: Friday Oct 30 2 PM EDT is due Tuesday Nov 3 2 PM EST, same wall clock", same(dst.dueAt, et(11, 3, 14)) && dst.dueAt.getUTCHours() === 19, `${show(dst.dueAt)} (${dst.dueAt.toISOString()})`);
    const sat = board.clientRoundClock(et(9, 26, 11));
    c.ok("an ask on Saturday starts Monday 00:00: due Wednesday 00:00", same(sat.dueAt, et(9, 30, 0)), show(sat.dueAt));
    const cases: [string, Date, Date][] = [
      ["a weekday morning before the office opens → 6 PM that day", et(9, 29, 6), et(9, 29, 18)],
      ["Tuesday 10 AM → Tuesday 6 PM", et(9, 29, 10), et(9, 29, 18)],
      ["one minute before 6 PM → that 6 PM", et(9, 29, 17, 59), et(9, 29, 18)],
      ["6 PM on the dot is after hours → Wednesday 6 PM", et(9, 29, 18), et(9, 30, 18)],
      ["Friday 7:30 PM → Monday 6 PM", et(9, 25, 19, 30), et(9, 28, 18)],
      ["Saturday 11 AM → Monday 6 PM", et(9, 26, 11), et(9, 28, 18)],
      ["Sunday 9 PM → Monday 6 PM", et(9, 27, 21), et(9, 28, 18)],
    ];
    for (const [label, at, want] of cases) {
      const got = board.sameDayDue(at);
      c.ok(`same-day: ${label}`, same(got, want), show(got));
    }
  }

  // =========================================================================
  c.head("§2 · a client round on a delivered job");
  // =========================================================================
  setClock(et(9, 25, 14).getTime());
  const J1 = await mkJob({ street: "1 Client Round Rd", status: "DELIVERED", deliveredAt: et(9, 18, 12) });
  await raiseRevision({ projectId: J1.id, clientId: client.id, note: "Can you swap the song and trim the ending?", source: "openphone" });
  const b1 = await prisma.revisionBrief.findFirst({ where: { projectId: J1.id }, select: { dueSource: true, targetAt: true, dueAt: true, dueSetBy: true, source: true } });
  c.ok("the ask's brief carries §3's clock, written when it arrived", b1?.dueSource === "CLIENT_ROUND" && same(b1.targetAt, et(9, 28, 14)) && same(b1.dueAt, et(9, 29, 14)), `${b1?.dueSource} ${show(b1?.targetAt)} / ${show(b1?.dueAt)}`);
  const t1 = await prisma.smartTask.findFirst({ where: { projectId: J1.id, taskType: "revision" }, select: { dueAt: true, assignedKey: true } });
  c.ok("…and the revision card carries the same date (no longer 'revisions promise nothing')", same(t1?.dueAt, et(9, 29, 14)), show(t1?.dueAt));
  {
    const ob = await oldBoardOf(J1.id);
    const oq = await oldRowOf(J1.id);
    const obr = await oldBrief.projectBrief(J1.id);
    c.ok(`old (${BASE}): the board had no date for it, the brief had no date, and the queue called it LATE against the promise it had kept`,
      !!ob && ob.dueAt === null && !!obr && obr.promisedAt === null && !!oq && oq.late === true && sameISO(oq.dueISO, et(9, 16, 10)),
      `board ${show(ob?.dueAt)} · brief ${show(obr?.promisedAt)} · queue ${oq?.dueISO} late=${oq?.late}`);
    const nb = await boardOf(J1.id);
    const nq = await rowOf(J1.id);
    const nbr = await projectBrief(J1.id);
    c.ok("new: the board, the brief and the Editing Room row all read Tuesday 2 PM, not late",
      same(nb?.dueAt, et(9, 29, 14)) && exact(nbr?.promisedAt, nb?.dueAt) && sameISO(nq?.dueISO, et(9, 29, 14)) && nq?.dueISO === nb?.dueAt?.toISOString() && nb?.overdue === false && nbr?.overdue === false && nq?.late === false,
      `board ${show(nb?.dueAt)} · brief ${show(nbr?.promisedAt)} · queue ${nq?.dueISO}`);
    c.ok("…and each says where the date came from, in plain words",
      nb?.dueTierLabel === "client revision · 24 to 48 business hours" && nbr?.promiseWords === nb?.dueTierLabel && nq?.dueNote === nb?.dueTierLabel && nb?.dueFor === "the client's changes",
      `${nb?.dueTierLabel} | ${nbr?.promiseWords} | ${nq?.dueNote} | for ${nb?.dueFor}`);
    c.ok("the brief's internal target is the round's 24 hours, not the original job's", same(nbr?.targetAt, et(9, 28, 14)), show(nbr?.targetAt));
  }

  // =========================================================================
  c.head("§3 · an addendum keeps its round's clock; a second ask never pushes the date out");
  // =========================================================================
  {
    const J = await mkJob({ street: "3 Addendum Ave", status: "REVISION", deliveredAt: et(9, 20, 12), revisionRequestedAt: et(9, 25, 14) });
    const pin = { submissionId: "sub-drill-1", outputId: null, cutKey: null, decisionId: "dec-drill-1", roundId: null };
    await rb.createRevisionBrief({ projectId: J.id, source: "portal", sourceDetail: "decision:dec-drill-1", text: "Brighter intro please", pin, skipAnalysis: false });
    setClock(et(9, 25, 17).getTime());
    await rb.createRevisionBrief({ projectId: J.id, source: "portal", sourceDetail: "decision:dec-drill-1:addendum:1", text: "Also the logo at the end", pin, skipAnalysis: true });
    const rows = await prisma.revisionBrief.findMany({ where: { projectId: J.id }, orderBy: { createdAt: "asc" }, select: { dueAt: true, targetAt: true } });
    c.ok("three hours later, the addendum carries the FIRST ask's clock (Tue 2 PM), not its own", rows.length === 2 && exact(rows[1].dueAt, rows[0].dueAt) && same(rows[1].dueAt, et(9, 29, 14)), rows.map((r) => show(r.dueAt)).join(" · "));
    await rb.createRevisionBrief({ projectId: J.id, source: "gmail", text: "One more: the agent's name is spelled wrong" });
    const third = await prisma.revisionBrief.findFirst({ where: { projectId: J.id, source: "gmail" }, select: { dueAt: true } });
    const nb = await boardOf(J.id);
    c.ok("a separate later ask has its own clock (Tue 5 PM) and the job still reads the earliest (Tue 2 PM)", same(third?.dueAt, et(9, 29, 17)) && same(nb?.dueAt, et(9, 29, 14)), `${show(third?.dueAt)} / job ${show(nb?.dueAt)}`);
    setClock(et(9, 25, 14).getTime());
  }

  // =========================================================================
  c.head("§4 · the office reopens a finished job");
  // =========================================================================
  const J2 = await mkJob({ street: "2 New Cut Ln", status: "DELIVERED", deliveredAt: et(9, 17, 12) });
  {
    const r = await editingActions.addToEditorQueue(J2.id, "kim", "Make a 30-second cut for Instagram");
    const brief = await prisma.revisionBrief.findFirst({ where: { projectId: J2.id }, select: { source: true, dueSource: true, dueAt: true, targetAt: true, itemsJson: true, originalText: true } });
    c.ok("a new cut queued on a delivered job at Friday 2 PM is due Friday 6 PM, the same business day", r.ok && brief?.dueSource === "REOPENED_SAME_DAY" && same(brief.dueAt, et(9, 25, 18)) && brief.targetAt === null, `${r.message} · ${brief?.dueSource} ${show(brief?.dueAt)}`);
    c.ok("…written as the OFFICE's row: no items, and words nobody can take for the client's", brief?.source === "office" && brief.itemsJson === null && /not a client request/.test(brief.originalText), brief?.originalText);
    c.ok("…and no revision issue was made from it", (await prisma.revisionIssue.count({ where: { projectId: J2.id } })) === 0);
    const nb = await boardOf(J2.id);
    const nq = await rowOf(J2.id);
    const nbr = await projectBrief(J2.id);
    c.ok("board, brief and queue agree: Friday 6 PM, 'reopened · due the same business day'",
      exact(nb?.dueAt, et(9, 25, 18)) && exact(nbr?.promisedAt, et(9, 25, 18)) && nq?.dueISO === et(9, 25, 18).toISOString() && nb?.dueTierLabel === "reopened · due the same business day" && nq?.dueNote === nb?.dueTierLabel,
      `${show(nb?.dueAt)} · ${nb?.dueTierLabel}`);
    c.ok("the project brief's 'Client asked' line does not quote the office's note", !nbr?.latestRequest || !/not a client request/.test(nbr.latestRequest.text), nbr?.latestRequest?.text ?? "none");
    const task = await prisma.smartTask.findFirst({ where: { projectId: J2.id, taskType: "revision" }, select: { dueAt: true } });
    c.ok("(ordering) the queue-add writes its revision card AFTER the clock, so the card starts undated…", task?.dueAt === null, show(task?.dueAt));
    const net = await rb.reconcileReopenedClocks();
    const task2 = await prisma.smartTask.findFirst({ where: { projectId: J2.id, taskType: "revision" }, select: { dueAt: true } });
    c.ok("…and the hourly net gives it the job's date within the hour", same(task2?.dueAt, et(9, 25, 18)) && net.mirrored >= 1, `${show(task2?.dueAt)} · ${JSON.stringify(net)}`);
    const oq = await oldRowOf(J2.id);
    c.ok(`old (${BASE}): the same row read LATE against the Sep 16 delivery promise`, oq?.late === true, `${oq?.dueISO} late=${oq?.late}`);
  }
  const J3 = await mkJob({ street: "3 Pill Flip Pl", status: "DELIVERED", deliveredAt: et(9, 17, 12) });
  {
    await prisma.smartTask.create({ data: { taskType: "edit_video", title: "Edit — 3 Pill Flip Pl", status: "COMPLETED", assignedKey: "kim", assignedManually: true, projectId: J3.id, clientId: client.id, dedupeKey: `edit-video-${J3.id}`, dueAt: et(9, 15, 22) } });
    setClock(et(9, 25, 19, 30).getTime());
    const r = await editingActions.setQueueStatus(J3.id, "Revisions");
    const brief = await prisma.revisionBrief.findFirst({ where: { projectId: J3.id }, select: { dueSource: true, dueAt: true } });
    const card = await prisma.smartTask.findFirst({ where: { dedupeKey: `edit-video-${J3.id}` }, select: { dueAt: true, status: true } });
    c.ok("Revisions on the pill of a delivered row at Friday 7:30 PM (after hours) is due Monday 6 PM", r.ok && brief?.dueSource === "REOPENED_SAME_DAY" && same(brief.dueAt, et(9, 28, 18)), `${r.message} · ${show(brief?.dueAt)}`);
    c.ok("…and the edit card's round is due then too, not by the ORIGINAL shoot's SLA (born weeks overdue before)", card?.status === "OPEN" && same(card.dueAt, et(9, 28, 18)), `${card?.status} ${show(card?.dueAt)}`);
    setClock(et(9, 25, 14).getTime());
  }

  // =========================================================================
  c.head("§5 · a board move off Delivered — the hourly net dates it from the move");
  // =========================================================================
  const J4 = await mkJob({ street: "4 Board Move Blvd", status: "DELIVERED", deliveredAt: et(9, 17, 12) });
  {
    setClock(et(9, 26, 11).getTime()); // Saturday
    await appActions.moveProjectStatus(J4.id, "EDITING");
    // The timeline row is stamped by the database's clock, which is the real
    // one; in production the two are the same clock, so it is set to the
    // drill's here rather than letting the test pass on the wall time.
    await prisma.activity.updateMany({ where: { projectId: J4.id, body: { startsWith: "Moved from Delivered to " } }, data: { createdAt: new Date() } });
    const before = await boardOf(J4.id);
    c.ok("straight after the move nothing dates it: no date, flagged undated on the board", before?.dueAt === null && before?.reopenedUndated === true, `${show(before?.dueAt)} undated=${before?.reopenedUndated}`);
    const ex = await exceptionOf(J4.id);
    c.ok("…and it is on Kyle's exceptions: reopened, no due date, his to set", ex?.severity === "medium" && ex.owner === "Kyle" && /no due date/.test(ex.why), ex ? `${ex.why} · ${ex.owner}` : "none");
    setClock(et(9, 26, 11, 50).getTime());
    const net = await rb.reconcileReopenedClocks();
    const after = await boardOf(J4.id);
    c.ok("the net stamps it from the MOVE (Saturday 11 AM → Monday 6 PM), not from when the net ran", net.stamped >= 1 && same(after?.dueAt, et(9, 28, 18)), `${JSON.stringify(net)} · ${show(after?.dueAt)}`);
    c.ok("…and it leaves the exceptions (dated, not late)", (await exceptionOf(J4.id)) === null);
    // The office dates a reopen itself before the net gets there: its word stands.
    const J4b = await mkJob({ street: "4 Office Dated Dr", status: "DELIVERED", deliveredAt: et(9, 17, 12) });
    setClock(et(9, 26, 11).getTime());
    await appActions.moveProjectStatus(J4b.id, "EDITING");
    await prisma.activity.updateMany({ where: { projectId: J4b.id, body: { startsWith: "Moved from Delivered to " } }, data: { createdAt: new Date() } });
    setClock(et(9, 26, 11, 20).getTime());
    await prisma.project.update({ where: { id: J4b.id }, data: { dueOverrideAt: et(9, 28, 9), overrideAt: new Date() } });
    setClock(et(9, 26, 11, 50).getTime());
    await rb.reconcileReopenedClocks();
    const d = await boardOf(J4b.id);
    c.ok("an office date saved after the move and before the net: no clock is stamped, the board reads the office's Monday 9 AM", (await officeBriefs(J4b.id)) === 0 && exact(d?.dueAt, et(9, 28, 9)) && d?.dueTierLabel === "set by the office", `${show(d?.dueAt)} ${d?.dueTierLabel}`);
    setClock(et(9, 25, 14).getTime());
  }

  // =========================================================================
  c.head("§6 · history is never back-dated; a person dates it");
  // =========================================================================
  const J5 = await mkJob({ street: "5 Old Reopen Ct", status: "REVISION", deliveredAt: et(9, 5, 12), revisionRequestedAt: et(9, 10, 9), shootDate: et(9, 2, 10) });
  {
    const net = await rb.reconcileReopenedClocks();
    const nb = await boardOf(J5.id);
    const nq = await rowOf(J5.id);
    c.ok("a reopen from Sep 10 (before the clock existed) is NOT stamped — it would be born 15 days late", (await prisma.revisionBrief.count({ where: { projectId: J5.id } })) === 0 && net.undated >= 1, JSON.stringify(net));
    c.ok("board: no date, undated, floated to the top of Upcoming", nb?.dueAt === null && nb?.reopenedUndated === true, `${show(nb?.dueAt)}`);
    const up = (await board.deliveryBoard()).upcoming;
    c.ok("…ahead of every dated job in Upcoming", up.findIndex((j) => j.id === J5.id) < up.findIndex((j) => !!j.dueAt) || up.every((j) => !j.dueAt || j.id === J5.id), up.slice(0, 4).map((j) => j.title).join(", "));
    c.ok("queue: no date, not late (it said LATE before)", nq?.dueISO === null && nq?.late === false && nq?.dueNote === "reopened · no due date yet", `${nq?.dueISO} ${nq?.dueNote}`);
    const oq = await oldRowOf(J5.id);
    c.ok(`old (${BASE}): LATE against the Sep 4 promise it had kept`, oq?.late === true, `${oq?.dueISO}`);
    const ex = await exceptionOf(J5.id);
    c.ok("Kyle's exceptions: 'Reopened … with no due date', owner Kyle, set it on the edit page", ex?.owner === "Kyle" && ex.nextAction === "Set its due date on the job's edit page" && /Reopened .* with no due date/.test(ex.why), ex?.why);
    const refused = await rb.moveReopenedDue({ projectId: J5.id, dueAt: et(9, 24, 12), by: "Kyle Cabrera" });
    c.ok("a date that has already passed is refused", !refused.ok, refused.message);
    const moved = await rb.moveReopenedDue({ projectId: J5.id, dueAt: et(9, 28, 12), by: "Kyle Cabrera" });
    const row = await prisma.revisionBrief.findFirst({ where: { projectId: J5.id }, select: { dueSource: true, dueSetBy: true, dueSetAt: true, source: true } });
    const nb2 = await boardOf(J5.id);
    c.ok("Kyle sets Monday noon: a MANUAL row with who and when", moved.ok && row?.dueSource === "MANUAL" && row.dueSetBy === "Kyle Cabrera" && same(row.dueSetAt, et(9, 25, 14)) && row.source === "office", `${row?.dueSource} ${row?.dueSetBy} ${show(row?.dueSetAt)}`);
    c.ok("…the board reads it, 'moved by Kyle Cabrera'", same(nb2?.dueAt, et(9, 28, 12)) && nb2?.dueTierLabel === "moved by Kyle Cabrera", `${show(nb2?.dueAt)} ${nb2?.dueTierLabel}`);
    c.ok("…the timeline says it had none", (await prisma.activity.count({ where: { projectId: J5.id, body: { contains: "moved to" }, AND: [{ body: { contains: "(it had none)" } }] } })) === 1);
    c.ok("…and it is off the exceptions", (await exceptionOf(J5.id)) === null);
    const again = await rb.moveReopenedDue({ projectId: J5.id, dueAt: et(9, 29, 12), by: "Jordan Spackman" });
    const nb3 = await boardOf(J5.id);
    c.ok("moving it again moves the same row, and the timeline keeps what it was", again.ok && (await prisma.revisionBrief.count({ where: { projectId: J5.id } })) === 1 && same(nb3?.dueAt, et(9, 29, 12)) && (await prisma.activity.count({ where: { projectId: J5.id, body: { contains: "(was " } } })) === 1, nb3?.dueTierLabel ?? "");
  }

  // =========================================================================
  c.head("§7 · an office date saved for the ORIGINAL work");
  // =========================================================================
  const J6 = await mkJob({ street: "6 Stale Override Way", status: "DELIVERED", deliveredAt: et(9, 12, 12), dueOverrideAt: et(9, 10, 17), overrideAt: et(9, 8, 9) });
  {
    await raiseRevision({ projectId: J6.id, clientId: client.id, note: "Please remove the neighbour's car", source: "gmail" });
    const ob = await oldBoardOf(J6.id);
    c.ok(`old (${BASE}): the office's Sep 10 date — set before the job was even delivered — made it LATE the moment the client wrote`, ob?.overdue === true && same(ob?.dueAt, et(9, 10, 17)), `${show(ob?.dueAt)} ${ob?.dueTierLabel}`);
    const nb = await boardOf(J6.id);
    c.ok("new: that date was for the original work; the round's own clock stands (Tuesday 2 PM)", nb?.overdue === false && same(nb?.dueAt, et(9, 29, 14)), `${show(nb?.dueAt)} ${nb?.dueTierLabel}`);
    await prisma.project.update({ where: { id: J6.id }, data: { dueOverrideAt: et(9, 28, 10), overrideAt: new Date() } });
    const nb2 = await boardOf(J6.id);
    const nq = await rowOf(J6.id);
    c.ok("an office date saved AFTER the reopen still wins, labelled as the office's", exact(nb2?.dueAt, et(9, 28, 10)) && nb2?.dueTierLabel === "set by the office" && nq?.dueISO === et(9, 28, 10).toISOString(), `${show(nb2?.dueAt)} ${nb2?.dueTierLabel}`);
  }

  // =========================================================================
  c.head("§8 · past due is late everywhere, and on Kyle's exceptions");
  // =========================================================================
  {
    setClock(et(9, 29, 15).getTime()); // Tuesday 3 PM — J1 was due at 2
    const nb = await boardOf(J1.id);
    const nq = await rowOf(J1.id);
    const nbr = await projectBrief(J1.id);
    c.ok("the client round due Tuesday 2 PM is late at 3 PM on the board, the brief and the queue", nb?.overdue === true && nbr?.overdue === true && nq?.late === true);
    const bd = await board.deliveryBoard();
    c.ok("…and it rides in the board's Today column", bd.today.some((j) => j.id === J1.id));
    const rw = (await board.reopenedWork({ now: new Date() })).find((r) => r.projectId === J1.id);
    c.ok("the reopened-work reader has it late, with Tuesday's clock", rw?.overdue === true && same(rw.due.at, et(9, 29, 14)), `${show(rw?.due.at)} overdue=${rw?.overdue}`);
    // The most overdue first, four to a kind: the Friday 6 PM new cut (§4),
    // held by Kim, leads the page.
    const ex = await exceptionOf(J2.id);
    c.ok("Kyle's exceptions: high, 'was due Fri …', owned by the editor holding the work", ex?.severity === "high" && /was due Fri, Sep 25, 6:00 PM/.test(ex.why) && /^Kim/.test(ex.owner) && ex.href === `/edit/${J2.id}`, ex ? `${ex.why} · ${ex.owner}` : "none");
    const totals = (await opsExceptionsBoard({ now: new Date() })).totals["reopened-work"];
    c.ok("…counted in the board's totals, the late ones as worth doing today", totals.all >= 1 && totals.high >= 1, JSON.stringify(totals));
    setClock(et(9, 25, 14).getTime());
  }

  // =========================================================================
  c.head("§9 · settle, then reopen again: the old clock is met, never inherited");
  // =========================================================================
  {
    // Forward, never back: the sections above reset the clock to Friday 2 PM,
    // and a settle "before" a clock that was stamped after it is a drill
    // artifact, not a case (production time only runs one way).
    setClock(et(9, 25, 20).getTime());
    await appActions.moveProjectStatus(J2.id, "DELIVERED");
    const marker = await prisma.appSetting.findUnique({ where: { key: board.reopenSettledKey(J2.id) } });
    const nb = await boardOf(J2.id);
    c.ok("moved to Delivered: the settle marker is written and the job is settled (no date, not late)", !!marker && nb?.settled === true && nb.dueAt === null && nb.overdue === false, `${marker?.value} settled=${nb?.settled}`);
    const net = await rb.reconcileReopenedClocks();
    const marker2 = await prisma.appSetting.findUnique({ where: { key: board.reopenSettledKey(J2.id) } });
    c.ok("the hourly net does not rewrite a settle that already happened", marker2?.value === marker?.value, JSON.stringify(net));
    setClock(et(10, 5, 10).getTime()); // a week and a half later, the Friday 6 PM clock long past
    await raiseRevision({ projectId: J2.id, clientId: client.id, note: "The new cut needs captions", source: "openphone" });
    const nb2 = await boardOf(J2.id);
    c.ok("the client writes again Oct 5: the job is due by the NEW round (Wed Oct 7 10 AM), not late by the old Friday 6 PM", nb2?.overdue === false && same(nb2?.dueAt, et(10, 7, 10)) && nb2?.dueTierLabel === "client revision · 24 to 48 business hours", `${show(nb2?.dueAt)} ${nb2?.dueTierLabel}`);
    setClock(et(9, 25, 14).getTime());
  }

  // =========================================================================
  c.head("§10 · an extra shoot on a delivered job");
  // =========================================================================
  const J7 = await mkJob({ street: "7 Extra Shoot St", status: "DELIVERED", deliveredAt: et(9, 18, 12) });
  {
    const extra = await prisma.deliverable.create({
      data: { projectId: J7.id, type: "SOCIAL_REEL", label: "Additional reel — shot Sep 24", manual: true, capturedAt: et(9, 24, 10), status: "UPLOADED", uploadedAt: et(9, 24, 18) },
      select: { id: true },
    });
    await prisma.deliverableOutput.create({
      data: { deliverableId: extra.id, projectId: J7.id, slot: 1, category: "Video", promisedAt: et(9, 28, 17), targetAt: et(9, 28, 12), promiseSource: "additional-shoot", promiseAnchorAt: et(9, 24, 10) },
    });
    const ob = await oldBoardOf(J7.id);
    c.ok(`old (${BASE}): the board filed it under Delivered with no date while the queue listed it owed`, ob?.settled === true && ob.dueAt === null, `settled=${ob?.settled}`);
    const nb = await boardOf(J7.id);
    const nq = await rowOf(J7.id);
    const nbr = await projectBrief(J7.id);
    c.ok("new: the board lists it as live work, due Monday 5 PM — the extra video's own promise", nb?.settled === false && nb.reopened && same(nb.dueAt, et(9, 28, 17)) && nb.dueTierLabel === "extra video · its own promise" && nb.blockerLabel === "Extra video owed", `${show(nb?.dueAt)} · ${nb?.blockerLabel}`);
    c.ok("…the same date as the queue row and the brief", nq?.dueISO === et(9, 28, 17).toISOString() && nq.status === "Extra video owed" && exact(nbr?.promisedAt, et(9, 28, 17)), `${nq?.dueISO} · ${show(nbr?.promisedAt)}`);
    await prisma.reviewSubmission.create({ data: { projectId: J7.id, kind: "video", deliverableId: extra.id, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "extra.mp4", decidedAt: new Date() } });
    const nb2 = await boardOf(J7.id);
    c.ok("its cut approved: the job settles back to Delivered (the send is the Ready-to-send card's)", nb2?.settled === true && nb2.dueAt === null, `settled=${nb2?.settled}`);
  }

  // =========================================================================
  c.head("§11 · races and re-runs write one clock");
  // =========================================================================
  {
    const J8 = await mkJob({ street: "8 Race Rd", status: "EDITING", deliveredAt: et(9, 18, 12) });
    const rs = await Promise.all([1, 2, 3].map(() => rb.stampReopenedClock(J8.id, { why: "drill race" })));
    c.ok("three stamps at once on one reopened job: exactly one row", (await officeBriefs(J8.id)) === 1 && rs.filter((r) => r.stamped).length === 1, rs.map((r) => r.reason).join(" / "));
    await rb.reconcileReopenedClocks();
    await rb.reconcileReopenedClocks();
    c.ok("two more net passes: still one", (await officeBriefs(J8.id)) === 1);
    const J8b = await mkJob({ street: "8 Never Delivered Dr", status: "EDITING" });
    const r = await rb.stampReopenedClock(J8b.id, { why: "drill" });
    c.ok("a job never delivered is not reopened work: nothing stamped", !r.stamped && (await officeBriefs(J8b.id)) === 0, r.reason);
  }

  // =========================================================================
  c.head("§12 · a job never delivered keeps its delivery promise");
  // =========================================================================
  {
    const J9 = await mkJob({ street: "9 First Pass Pike", status: "REVIEW", shootDate: et(9, 24, 10), delivered: false });
    const before = await boardOf(J9.id);
    await raiseRevision({ projectId: J9.id, clientId: client.id, note: "Could the intro be shorter?", source: "gmail" });
    const after = await boardOf(J9.id);
    const task = await prisma.smartTask.findFirst({ where: { projectId: J9.id, taskType: "revision" }, select: { dueAt: true } });
    c.ok("the board still reads the delivery promise (a job never delivered keeps the promise it is breaking)", !!before?.dueAt && same(after?.dueAt, before.dueAt) && !after?.reopened, `${show(before?.dueAt)} → ${show(after?.dueAt)}`);
    c.ok("…while the revision card carries the round's 48 business hours", same(task?.dueAt, et(9, 29, 14)), show(task?.dueAt));
  }

  // =========================================================================
  c.head("§13 · the photographer KPI does not count an office reopen");
  // =========================================================================
  {
    const P = await prisma.teamMember.create({ data: { name: "Drill Shooter", email: "shooter@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await prisma.project.create({
        data: { title: `${40 + i} Kpi Way, Royersford, PA`, clientId: client.id, status: i === 0 ? "EDITING" : "DELIVERED", aryeoOrderId: `drill-kpi-${i}`, shootDate: et(9, 1 + i, 10), deliveredAt: et(9, 3 + i, 10), photographerId: P.id },
        select: { id: true },
      });
      ids.push(p.id);
    }
    const s = await rb.stampReopenedClock(ids[0], { why: "the office wants a longer cut" });
    const word = (card: Awaited<ReturnType<typeof scoreQuarter>>) => card.areas.find((a) => a.key === "revisions")?.value ?? "";
    const oldCard = await oldKpi.scoreQuarter({ memberId: P.id });
    const newCard = await scoreQuarter({ memberId: P.id });
    c.ok(`old (${BASE}): an office reopen would have read as a shoot that came back`, s.stamped && /\(1 of 5\)/.test(word(oldCard)), word(oldCard));
    c.ok("new: it does not count against the photographer", /\(0 of 5\)/.test(word(newCard)), word(newCard));
  }

  // =========================================================================
  c.head("§14 · A32: an EDITING nobody confirmed reads \"Waiting on instructions\"");
  // =========================================================================
  {
    const SENTENCE = "Waiting on the flow and vision for the edit, the wrap-up on the upload page from Harrison Wells.";
    const J10 = await mkJob({ street: "10 Unconfirmed Edit Ct", status: "EDITING", blocked: SENTENCE, delivered: false });
    const card = await prisma.smartTask.create({ data: { taskType: "edit_video", title: "Edit — 10 Unconfirmed Edit Ct", status: "OPEN", assignedKey: "kim", assignedManually: true, projectId: J10.id, clientId: client.id, dedupeKey: `edit-video-${J10.id}` }, select: { id: true } });
    const said = SENTENCE.replace(/\.$/, "");
    const oq = await oldRowOf(J10.id);
    c.ok(`old (${BASE}): the queue said "In editing — not confirmed" while the card and board said it was waiting`, oq?.status === "In editing — not confirmed", oq?.status);
    const nq = await rowOf(J10.id);
    const nb = await boardOf(J10.id);
    const nc = (await appActions.editCardWork([card.id])).cards[card.id];
    c.ok("new: the queue row reads \"Waiting on instructions\" with the engine's sentence", nq?.status === "Waiting on instructions" && nq.blocker === said, `${nq?.status} · ${nq?.blocker}`);
    c.ok("…the edit card says the same", nc?.text === "Waiting on instructions" && nc.blocker === said, nc?.text);
    c.ok("…and Kyle's board carries the sentence as its blocker", nb?.blocker === "handoff_incomplete" && nb.blockerLabel === said, nb?.blockerLabel);
  }

  // =========================================================================
  c.head("§15 · the edit page's tracker says where the date came from");
  // =========================================================================
  {
    const { EditTracker } = await import("@/components/editing/EditTracker");
    type El = { type?: unknown; props?: Record<string, unknown> } | string | number | null | undefined | boolean | El[];
    const texts: string[] = [];
    const forms: Record<string, unknown>[] = [];
    const walk = (n: El): void => {
      if (n == null || typeof n === "boolean") return;
      if (typeof n === "string" || typeof n === "number") { texts.push(String(n)); return; }
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const t = n.type;
      if (t === "form") forms.push(n.props ?? {});
      if (typeof t === "function" && (t as { name?: string }).name !== "SlaCountdown") {
        try { walk((t as (p: unknown) => El)(n.props)); } catch { /* a client hook — not ours to render */ }
        return;
      }
      walk(n.props?.children as El);
    };
    const action = async () => {};
    walk(EditTracker({
      stage: "revision", statusLine: "Changes requested", hadRevision: true, editType: "Standard Reel", dueISO: et(9, 25, 18).toISOString(),
      shootDateISO: null, photographerName: null, song: null, rounds: [], revisionAsks: [], revisionAtISO: null, showSubmitAnchor: false,
      dueWords: "reopened · due the same business day",
      moveDue: { action, projectId: J2.id, defaultLocal: "2026-09-25T18:00", notice: { ok: true, text: "Moved." } },
    }) as El);
    c.ok("the Deadline fact carries the source words under the date", texts.includes("reopened · due the same business day"));
    c.ok("the office's move form posts the job id and an ET datetime", forms.length === 1 && forms[0].action === action && forms[0].id === "reopened-due");
    const page = fs.readFileSync(path.join(REPO, "src/app/edit/[id]/page.tsx"), "utf8");
    c.ok("the page offers the form to owner/admin only, and the action re-checks the role", /reopened && strictOwnerAdmin && !viewer\?\.impersonating/.test(page) && /requireRole\(\["OWNER", "ADMIN"\]\)/.test(page));
  }

  // =========================================================================
  c.head("§15b · (review, Sep 25) the office's DUE is dated by when the date was saved, not the override record");
  // =========================================================================
  // Through the REAL override dialog (saveEditOverrides), which writes
  // overrideAt on every save and one "Override by … due …" line when the date
  // changes. Timeline rows are stamped by the database's clock (the real one),
  // so each line is moved onto the drill's clock, as §5 does.
  const toDrillClock = async (projectId: string, startsWith: string) => {
    const last = await prisma.activity.findFirst({ where: { projectId, body: { startsWith } }, orderBy: { createdAt: "desc" }, select: { id: true } });
    if (last) await prisma.activity.update({ where: { id: last.id }, data: { createdAt: new Date() } });
  };
  {
    // A. The office dated the ORIGINAL work; the client asks later; Kyle only
    //    bumps the priority the day after. The stale date must stay stale.
    const J7 = await mkJob({ street: "7 Priority Bump Rd", status: "EDITING", shootDate: et(9, 8, 10) });
    setClock(et(9, 9, 9).getTime());
    const set = await editingActions.saveEditOverrides(J7.id, { dueAt: et(9, 11, 17).toISOString() });
    await toDrillClock(J7.id, "Override by ");
    await prisma.project.update({ where: { id: J7.id }, data: { status: "DELIVERED", deliveredAt: et(9, 10, 12) } });
    setClock(et(9, 25, 14).getTime());
    await raiseRevision({ projectId: J7.id, clientId: client.id, note: "Swap the second song please", source: "gmail" });
    setClock(et(9, 26, 10).getTime()); // Saturday: Kyle bumps the priority only
    const bump = await editingActions.saveEditOverrides(J7.id, { priority: "HIGH" });
    await toDrillClock(J7.id, "Override by ");
    const p7 = await prisma.project.findUniqueOrThrow({ where: { id: J7.id }, select: { dueOverrideAt: true, overrideAt: true, deliveredAt: true } });
    const clock7 = (await board.reopenedClocksFor([J7.id])).get(J7.id) ?? null;
    c.ok("(the dialog saved the original date, then a priority-only save moved overrideAt past the reopen)",
      set.ok && bump.ok && exact(p7.dueOverrideAt, et(9, 11, 17)) && same(p7.overrideAt, et(9, 26, 10)), `${set.message} / ${bump.message}`);
    const stale = board.reopenedDueFor(p7, clock7);
    c.ok("the bug, on the pure reader: read off overrideAt, the Sep 11 date wins as 'set by the office' — two weeks late", stale.source === "OFFICE_OVERRIDE" && exact(stale.at, et(9, 11, 17)), `${stale.source} ${show(stale.at)}`);
    const nb = await boardOf(J7.id);
    const nq = await rowOf(J7.id);
    const nbr = await projectBrief(J7.id);
    c.ok("board, brief and queue read the client round's own clock (Tuesday 2 PM), not late",
      same(nb?.dueAt, et(9, 29, 14)) && nb?.overdue === false && same(nbr?.promisedAt, et(9, 29, 14)) && nq?.late === false && !!nq?.dueISO && same(new Date(nq.dueISO), et(9, 29, 14)),
      `${show(nb?.dueAt)} ${nb?.dueTierLabel} · brief ${show(nbr?.promisedAt)} · queue ${nq?.dueISO}`);
    c.ok("…and it is not on Kyle's exceptions as late", !(await exceptionOf(J7.id))?.why.includes("was due"), (await exceptionOf(J7.id))?.why ?? "none");
    // The office then sets a date FOR THIS reopen: its word wins again.
    setClock(et(9, 26, 11).getTime());
    await editingActions.saveEditOverrides(J7.id, { dueAt: et(9, 28, 12).toISOString() });
    await toDrillClock(J7.id, "Override by ");
    const nb2 = await boardOf(J7.id);
    c.ok("a date saved for the reopen (Monday noon) still wins, 'set by the office'", exact(nb2?.dueAt, et(9, 28, 12)) && nb2?.dueTierLabel === "set by the office", `${show(nb2?.dueAt)} ${nb2?.dueTierLabel}`);

    // B. The office reopens from the board at 10:00, sets Friday 5 PM at 10:05,
    //    and Revisions is pressed on the pill at 10:20. The office's date stands.
    const J8 = await mkJob({ street: "8 Pill After Date Pl", status: "DELIVERED", deliveredAt: et(9, 17, 12) });
    await prisma.smartTask.create({ data: { taskType: "edit_video", title: "Edit — 8 Pill After Date Pl", status: "COMPLETED", assignedKey: "kim", assignedManually: true, projectId: J8.id, clientId: client.id, dedupeKey: `edit-video-${J8.id}`, dueAt: et(9, 15, 22) } });
    setClock(et(9, 28, 10).getTime());
    await appActions.moveProjectStatus(J8.id, "EDITING");
    await toDrillClock(J8.id, "Moved from Delivered to ");
    setClock(et(9, 28, 10, 5).getTime());
    await editingActions.saveEditOverrides(J8.id, { dueAt: et(10, 2, 17).toISOString() });
    await toDrillClock(J8.id, "Override by ");
    setClock(et(9, 28, 10, 20).getTime());
    const pill = await editingActions.setQueueStatus(J8.id, "Revisions");
    c.ok("Revisions on the pill after the office dated the reopen stamps NO same-day clock", pill.ok && (await officeBriefs(J8.id)) === 0, `${pill.message} · briefs ${await officeBriefs(J8.id)}`);
    const nb8 = await boardOf(J8.id);
    c.ok("…the board reads the office's Friday 5 PM", exact(nb8?.dueAt, et(10, 2, 17)) && nb8?.dueTierLabel === "set by the office", `${show(nb8?.dueAt)} ${nb8?.dueTierLabel}`);
    setClock(et(9, 28, 18, 1).getTime());
    c.ok("…and it is not late at 6:01 PM Monday", (await boardOf(J8.id))?.overdue === false);

    // C. No clock yet: the original date was saved in August, a NOTE-only save
    //    lands after the job is reopened from the board. The hourly net still
    //    dates the reopen the same day (it used to read the August date as the
    //    office's word for it and never stamp — late for good).
    const J9 = await mkJob({ street: "9 Note Save Ct", status: "EDITING", shootDate: et(8, 18, 10) });
    setClock(et(8, 20, 9).getTime());
    await editingActions.saveEditOverrides(J9.id, { dueAt: et(8, 26, 17).toISOString() });
    await toDrillClock(J9.id, "Override by ");
    await prisma.project.update({ where: { id: J9.id }, data: { status: "DELIVERED", deliveredAt: et(8, 25, 12) } });
    setClock(et(9, 30, 10).getTime());
    await appActions.moveProjectStatus(J9.id, "EDITING");
    await toDrillClock(J9.id, "Moved from Delivered to ");
    setClock(et(9, 30, 10, 2).getTime());
    await editingActions.saveEditOverrides(J9.id, { note: "Client wants the pool shot back in" });
    await toDrillClock(J9.id, "Override by ");
    setClock(et(9, 30, 10, 40).getTime());
    await rb.reconcileReopenedClocks();
    const nb9 = await boardOf(J9.id);
    c.ok("a note-only save after the reopen does not revive the August date: the net stamps it, due 6 PM the same day",
      (await officeBriefs(J9.id)) === 1 && same(nb9?.dueAt, et(9, 30, 18)) && nb9?.overdue === false, `${show(nb9?.dueAt)} ${nb9?.dueTierLabel}`);
    setClock(et(9, 25, 14).getTime());
  }

  // =========================================================================
  c.head("§16 · fences");
  // =========================================================================
  c.ok("the model was never called (short asks; an office reopen writes no analysis)", aiCalls === 0, `${aiCalls} calls`);
  const leaked = fence.blocked.filter((u) => !/slack\.com|hooks\.slack/.test(u));
  c.ok("nothing left the building except blocked team pings", leaked.length === 0, fence.blocked.slice(0, 4).join(", ") || "no outbound attempts");
  c.ok("no client-facing message rows were written", (await prisma.commLog.count({ where: { direction: "out" } }).catch(() => 0)) === 0);

  c.summary();
  quiet.restore();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
