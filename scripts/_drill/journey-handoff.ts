/**
 * ACCEPTANCE JOURNEYS — THE HANDOFF (Sep 20 2026).
 *
 *   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && set -a && source .env; set +a \
 *     && NODE_OPTIONS=--conditions=react-server \
 *        npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/journey-handoff.ts
 *
 * Five business scenarios driven end to end against an ISOLATED in-process
 * PGlite Postgres, with the BACKGROUND SWEEP run after every transition —
 * because that is where the audit said the shipped fixes would come apart, and
 * a merge fault proved it once already by only showing up an hour later.
 *
 *   1. A missing brief that nobody answers, swept hourly for five business
 *      days: the chase has to MATURE. The old code re-stamped it every run.
 *   2. Answering it clears the card, the project row and the exception board.
 *   3. The hourly sync finding raw files is not a photographer handing the job
 *      in — the server's first-submit gates still have to fire.
 *   4. A photo-only job that ran past its promise: photo words, photo owner,
 *      reachable Overdue, and no demand for a video script.
 *   5. An interrupted upload and a provider outage: nothing may report
 *      completion, and an unreadable folder may never read as an empty one.
 *
 * SAFETY. DATABASE_URL is overwritten before any app module loads, so the live
 * Neon is never touched. `fetch` is replaced with a guard that throws on every
 * external host, so no Slack ping, no client text, no Dropbox or Aryeo call can
 * leave this process; the Dropbox integration is replaced with a scripted stub
 * so journey 5's outage is deterministic rather than a real 429.
 *
 * THE CLOCK. Journey 1 needs days, so `Date` is replaced by a subclass whose
 * "now" is a settable offset. Every shipped function under test reads the wall
 * clock through `new Date()` / `Date.now()`, so this moves them all together.
 * Nothing else about Date changes: parsing, arithmetic and `instanceof` are the
 * real thing.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import Module from "node:module";

// ---------------------------------------------------------------------------
// THE CLOCK
// ---------------------------------------------------------------------------
const RealDate = Date;
// The simulated instant, in full. NOT an offset from the real clock: an offset
// creeps forward while the drill runs, and a tick that lands one second past
// 9am ET would then "prove" a deadline matured when it had only just arrived.
let SIM = RealDate.parse("2026-09-21T08:00:00-04:00");
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error — forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;
/** Put the simulated wall clock at this instant. */
const setNow = (iso: string) => { SIM = RealDate.parse(iso); };
const nowMs = () => SIM;
const nowDate = () => new RealDate(SIM);
const advanceHours = (n: number) => { SIM += n * 3_600_000; };

// ---------------------------------------------------------------------------
// NO OUTBOUND ANYTHING. The isolated database has no Slack/OpenPhone secret in
// it, so nothing should try — this is the belt to that brace, and it is also
// what makes journey 3's real finalizeUpload (which ends by calling the status
// sweep) safe to run with production credentials sitting in the environment.
// ---------------------------------------------------------------------------
let blockedCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) return realFetch(input as RequestInfo, init);
  blockedCalls++;
  throw new Error(`drill: outbound network blocked (${url.slice(0, 60)})`);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// A SCRIPTED DROPBOX. `mode` is what the next folder read does.
// ---------------------------------------------------------------------------
type DbxEntry = { name: string; tag: string; path: string };
const DBX: { mode: "outage" | "missing" | "files"; files: DbxEntry[]; reads: number } = {
  mode: "missing",
  files: [],
  reads: 0,
};

const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
let dbxWrapper: Record<string, unknown> | null = null;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f };
  if (request === "next/navigation") return { redirect: () => { throw new Error("redirect"); }, notFound: () => { throw new Error("notFound"); } };
  if (request === "next/headers") return {};
  const real = realLoad.call(this, request, parent, isMain);
  // Deep imports reach `_load` as the alias tsx rewrote them to.
  if (/integrations\/dropbox$/.test(request)) {
    if (!dbxWrapper) {
      const m = real as Record<string, unknown>;
      const DropboxError = m.DropboxError as new (msg: string, status?: number) => Error;
      dbxWrapper = {
        ...m,
        __esModule: true,
        dropboxConfigured: () => true,
        dropboxListFolder: async (): Promise<DbxEntry[]> => {
          DBX.reads++;
          if (DBX.mode === "outage") throw new DropboxError("too_many_requests", 429);
          if (DBX.mode === "missing") throw new DropboxError("path/not_found/", 409);
          return DBX.files;
        },
      };
    }
    return dbxWrapper;
  }
  return real;
};

const exec = promisify(execFile);
const PORT = 5487;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
delete process.env.AUTH_ENFORCE;

let pass = 0, fail = 0;
const failures: string[] = [];
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  if (!good) failures.push(label);
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const note = (s: string) => console.log(`       ${s}`);
const et = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(d) : "none";

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const { ensureEditorHandoff } = await import("@/lib/tasks");
  const { opsExceptionsBoard } = await import("@/lib/opsExceptions");
  const { handoffReadiness } = await import("@/lib/handoff");
  const { addBusinessDaysET, endOfBusinessDaysET } = await import("@/lib/datetime");
  const { projectBrief } = await import("@/lib/projectBrief");
  const { finalizeUpload } = await import("@/app/upload/actions");
  const { folderFileCount, videoFilesUnder, getProjectFolderState, syncDropboxFolderStatus, actualFolderPaths } =
    await import("@/lib/dropboxFolders");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { DEBRIEF_PAY_GATE_FROM } = await import("@/lib/payroll");

  // THE SWEEP. This is the exact per-project call the hourly status sweep makes
  // (projectStatus.ts:1823, inside `if (["SHOT","EDITING","REVIEW"].includes(final))`).
  // It is called directly rather than through syncProjectStatuses so the drill
  // is not also testing Aryeo and Dropbox reachability — journey 3 runs the
  // full sweep through the real server action.
  const sweep = (projectId: string) => ensureEditorHandoff(projectId);

  const card = (projectId: string) =>
    prisma.smartTask.findUnique({
      where: { dedupeKey: `edit-video-${projectId}` },
      select: { id: true, status: true, blockedReason: true, followUpAt: true, updatedAt: true, dueAt: true, assignedKey: true },
    });
  const proj = (id: string) =>
    prisma.project.findUniqueOrThrow({
      where: { id },
      select: { status: true, handoffBlockedReason: true, handoffOwnerKey: true, handoffReadyAt: true, uploadedAt: true, debriefSubmittedAt: true },
    });
  const RAWS_IN = JSON.stringify({ present: [], dropbox: { rawPhotos: 143, rawVideo: 11, finalVideo: 0, stale: false } });

  const client = await prisma.client.create({ data: { name: "Mike Flatley" }, select: { id: true } });
  const harrison = await prisma.teamMember.create({
    data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER", payPercent: 0.35, payFloor: 100 },
    select: { id: true, name: true },
  });

  console.log("=".repeat(78));
  console.log("ACCEPTANCE JOURNEYS — the handoff, swept afterwards");
  console.log("=".repeat(78));

  console.log("\n0. THE HARNESS ITSELF");
  setNow("2026-09-21T08:00:00-04:00");
  ok("the simulated clock reads what it was set to", et(nowDate()).startsWith("Sep 21, 2026"), et(nowDate()));
  ok("the app is pointed at the isolated database, not Neon", (process.env.DATABASE_URL ?? "").includes("127.0.0.1"));
  let netOk = false;
  try { await fetch("https://slack.com/api/chat.postMessage"); } catch { netOk = true; }
  ok("every outbound call is refused before it leaves", netOk);

  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("JOURNEY 1 — an unchanged missing brief, swept hourly for five business days");
  console.log("-".repeat(78));

  const J1 = await prisma.project.create({
    data: {
      title: "2645 N 8th St, Philadelphia, PA",
      addressLine: "2645 N 8th St",
      clientId: client.id,
      status: "EDITING",
      source: "ARYEO",
      aryeoOrderId: "ord-j1",
      shootDate: new Date("2026-09-18T14:00:00-04:00"),
      deliveryDue: new Date("2026-09-24T17:00:00-04:00"),
      photographerId: harrison.id,
      statusEvidence: RAWS_IN,
      // The raws are in and nobody has said a word about the edit.
      videoInstructions: null,
      editorBrief: null,
      debriefSubmittedAt: null,
    },
    select: { id: true },
  });
  await prisma.deliverable.create({ data: { projectId: J1.id, type: "VIDEO", label: "Real Estate Video Tour", productTitle: "Real Estate Video Tour", quantity: 1 } });
  await prisma.orderItem.create({ data: { projectId: J1.id, title: "Real Estate Video Tour", amount: 45000 } });

  console.log("\n1a. THE FIRST SWEEP — Monday 8am ET");
  await sweep(J1.id);
  const c0 = await card(J1.id);
  ok("the editor gets a work item at all", !!c0, c0?.assignedKey ?? "");
  ok("it says what is missing, in words", !!c0?.blockedReason, c0?.blockedReason ?? "");
  ok("…and names the person it is waiting on", /Harrison Wells/.test(c0?.blockedReason ?? ""));
  ok("a chase date is set", !!c0?.followUpAt, et(c0?.followUpAt));
  const etHour = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(d));
  ok("the chase is at 9am ET, not midnight ET (= 04:00Z, the exact instant the hourly cron fires)",
    !!c0?.followUpAt && etHour(c0.followUpAt) === 9, `${et(c0?.followUpAt)} (hour ${c0?.followUpAt ? etHour(c0.followUpAt) : "?"} ET)`);
  ok("the project row carries the same blocker", !!(await proj(J1.id)).handoffBlockedReason, (await proj(J1.id)).handoffBlockedReason ?? "");
  ok("…and the same owner", (await proj(J1.id)).handoffOwnerKey === "harrison", (await proj(J1.id)).handoffOwnerKey ?? "none");

  console.log("\n1b. THE OLD WRITE, REPLAYED — what db6093a's predecessor did every hour");
  // Not the shipped function: this is the write the fix replaced
  // (`followUpAt: addBusinessDaysET(new Date(), 1)` on every pass, unconditional),
  // run against the same clock so the two can be compared honestly.
  {
    let everOverdue = 0;
    let clock = 0;
    const saveSim = nowMs();
    for (let h = 0; h < 120; h++) {
      const stamped = addBusinessDaysET(nowDate(), 1);
      if (stamped.getTime() < nowMs()) everOverdue++;
      clock = stamped.getTime();
      advanceHours(1);
    }
    ok("re-stamping every sweep, the chase is NEVER once in the past", everOverdue === 0, `${everOverdue} of 120 hourly ticks overdue`);
    note(`the last date it would have written: ${et(new RealDate(clock))}`);
    SIM = saveSim;
  }

  console.log("\n1c. THE SHIPPED SWEEP — 120 hourly ticks, Mon 8am ET → Sat 8am ET");
  const stamps = new Set<number>();
  const reasons = new Set<string>();
  let firstOverdueAt: Date | null = null;
  let firstBoardRowAt: Date | null = null;
  let updatedAtMoves = 0;
  let projectWrites = 0;
  let sweeps = 0;
  let lastUpdatedAt = (await card(J1.id))!.updatedAt.getTime();
  let lastProjectAt = (await prisma.project.findUniqueOrThrow({ where: { id: J1.id }, select: { updatedAt: true } })).updatedAt.getTime();
  for (let h = 0; h < 120; h++) {
    advanceHours(1);
    await sweep(J1.id);
    sweeps++;
    const pj = await prisma.project.findUniqueOrThrow({ where: { id: J1.id }, select: { updatedAt: true } });
    if (pj.updatedAt.getTime() !== lastProjectAt) { projectWrites++; lastProjectAt = pj.updatedAt.getTime(); }
    const c = await card(J1.id);
    if (c?.followUpAt) stamps.add(c.followUpAt.getTime());
    if (c?.blockedReason) reasons.add(c.blockedReason);
    if (c && c.updatedAt.getTime() !== lastUpdatedAt) { updatedAtMoves++; lastUpdatedAt = c.updatedAt.getTime(); }
    if (!firstOverdueAt && c?.followUpAt && c.followUpAt.getTime() < nowMs()) firstOverdueAt = nowDate();
    if (!firstBoardRowAt) {
      const b = await opsExceptionsBoard({ now: nowDate() });
      if (b.rows.some((r) => r.kind === "overdue-followup" && r.id === `followup:${c!.id}`)) firstBoardRowAt = nowDate();
    }
  }
  ok("the sweep really ran every hour", sweeps === 120, `${sweeps} sweeps`);
  ok("the chase date was written ONCE and never moved", stamps.size === 1, `${stamps.size} distinct date(s): ${[...stamps].map((t) => et(new RealDate(t))).join(", ")}`);
  ok("the blocker sentence never drifted either", reasons.size === 1, [...reasons].join(" / "));
  ok("THE CHASE MATURES — it is genuinely in the past while the job is still open", !!firstOverdueAt, firstOverdueAt ? `first overdue at ${et(firstOverdueAt)}` : "never came due in 5 business days");
  ok("…and the exception board picks it up", !!firstBoardRowAt, firstBoardRowAt ? `on the board from ${et(firstBoardRowAt)}` : "never appeared");
  ok("the hourly no-op sweeps do not churn the CARD's updatedAt", updatedAtMoves === 0, `${updatedAtMoves} of 120 sweeps rewrote the card`);
  ok("…nor the PROJECT row's, by the same discipline", projectWrites === 0, `${projectWrites} of 120 sweeps rewrote the project with values it already held`);
  if (projectWrites > 0) note("tasks.ts:3225 writes handoffBlockedReason/handoffOwnerKey on every pass — the card write below it reads before writing, this one never does.");

  const endBoard = await opsExceptionsBoard({ now: nowDate() });
  const j1Row = endBoard.rows.find((r) => r.kind === "overdue-followup");
  ok("by Saturday the row is on the board", !!j1Row, j1Row ? `${j1Row.title} — ${j1Row.why}` : "");
  ok("…aged into HIGH after three days", j1Row?.severity === "high", `${j1Row?.severity} at ${j1Row?.ageDays} days`);
  ok("…owned by a person, not 'Nobody yet'", !!j1Row && j1Row.owner !== "Nobody yet", j1Row?.owner ?? "");
  ok("…with the next move spelled out", j1Row?.nextAction === "Clear the blocker or move the date", j1Row?.nextAction ?? "");
  ok("the board's total counts the real pile", endBoard.totals["overdue-followup"].all === 1 && endBoard.totals["overdue-followup"].high === 1,
    JSON.stringify(endBoard.totals["overdue-followup"]));

  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("JOURNEY 2 — answering it clears the card, the project row and the board");
  console.log("-".repeat(78));

  console.log("\n2a. A DIFFERENT BLOCKER IS A NEW ASK — Harrison writes the brief but has not pressed Submit");
  const armedAt = [...stamps][0];
  await prisma.project.update({
    where: { id: J1.id },
    data: { videoInstructions: "STYLE: Cinematic\nVISION FOR THE EDIT\nOpen on the drone push to the porch, hold the kitchen island, end wide on the yard at golden hour." },
  });
  await sweep(J1.id);
  const c2a = await card(J1.id);
  ok("the brief gap is gone from the sentence", !/flow and vision/.test(c2a?.blockedReason ?? ""), c2a?.blockedReason ?? "(cleared)");
  ok("the wrap-up is still owed, so the card still says so", /wrap-up/.test(c2a?.blockedReason ?? ""), c2a?.blockedReason ?? "");
  ok("a CHANGED blocker re-arms a fresh chase day", !!c2a?.followUpAt && c2a.followUpAt.getTime() !== armedAt,
    `${et(new RealDate(armedAt))} → ${et(c2a?.followUpAt)}`);
  const board2a = await opsExceptionsBoard({ now: nowDate() });
  ok("…and the board goes quiet while the new day runs", board2a.totals["overdue-followup"].all === 0, JSON.stringify(board2a.totals["overdue-followup"]));

  console.log("\n2b. THE BLOCKER IS RESOLVED — Harrison presses Submit on the upload page");
  await prisma.project.update({ where: { id: J1.id }, data: { debriefSubmittedAt: nowDate() } });
  const readyNow = handoffReadiness({
    titles: ["Real Estate Video Tour"],
    hasFullVideo: true,
    debriefSubmittedAt: nowDate(),
    videoInstructions: "VISION FOR THE EDIT\nOpen on the drone push to the porch.",
    editorBrief: null, reelScript: null, reelHook: null, scriptConfirmedAt: null, videosFilmed: null,
    photographerName: harrison.name,
  });
  ok("the readiness engine now calls the handoff complete", readyNow.ready && readyNow.gaps.length === 0, `${readyNow.gaps.length} gaps`);
  await sweep(J1.id);
  const c2b = await card(J1.id);
  const p2b = await proj(J1.id);
  ok("the card's blocker is cleared", c2b?.blockedReason === null, String(c2b?.blockedReason));
  ok("THE CHASE DATE GOES WITH IT — both fields, or neither", c2b?.followUpAt === null, et(c2b?.followUpAt));
  ok("the project's stored blocker is cleared", p2b.handoffBlockedReason === null, String(p2b.handoffBlockedReason));
  ok("…and its owner key", p2b.handoffOwnerKey === null, String(p2b.handoffOwnerKey));
  ok("the moment it became workable is stamped once", !!p2b.handoffReadyAt, et(p2b.handoffReadyAt));
  const board2b = await opsExceptionsBoard({ now: nowDate() });
  ok("THE EXCEPTION BOARD IS QUIET", board2b.rows.filter((r) => r.kind === "overdue-followup").length === 0 && board2b.totals["overdue-followup"].all === 0,
    JSON.stringify(board2b.totals["overdue-followup"]));

  console.log("\n2c. IT STAYS CLEARED ACROSS THE NEXT TWO DAYS OF SWEEPS");
  const readyStamp = (await proj(J1.id)).handoffReadyAt!.getTime();
  let reArmed = 0;
  let readyWrites = 0;
  let lastReadyAt = (await prisma.project.findUniqueOrThrow({ where: { id: J1.id }, select: { updatedAt: true } })).updatedAt.getTime();
  for (let h = 0; h < 48; h++) {
    advanceHours(1);
    await sweep(J1.id);
    const pj = await prisma.project.findUniqueOrThrow({ where: { id: J1.id }, select: { updatedAt: true } });
    if (pj.updatedAt.getTime() !== lastReadyAt) { readyWrites++; lastReadyAt = pj.updatedAt.getTime(); }
    const c = await card(J1.id);
    if (c?.followUpAt || c?.blockedReason) reArmed++;
  }
  ok("48 more hourly sweeps never put the chase back", reArmed === 0, `${reArmed} of 48 sweeps re-armed it`);
  ok("…and the workable stamp is not re-written every hour", (await proj(J1.id)).handoffReadyAt!.getTime() === readyStamp);
  ok("…and a job that is already clear is not re-written at all", readyWrites === 0, `${readyWrites} of 48 sweeps rewrote the project row to the nulls it already held`);
  const board2c = await opsExceptionsBoard({ now: nowDate() });
  ok("the board is still quiet two days later", board2c.totals["overdue-followup"].all === 0, JSON.stringify(board2c.totals["overdue-followup"]));

  console.log("\n2d. A CUT LANDS ON A JOB THAT WAS STILL WEARING A BLOCKER (the second freeze path)");
  const J2 = await prisma.project.create({
    data: {
      title: "107 E Old Baltimore Pike, Media, PA", addressLine: "107 E Old Baltimore Pike",
      clientId: client.id, status: "REVIEW", source: "ARYEO", aryeoOrderId: "ord-j2",
      shootDate: new Date("2026-09-18T14:00:00-04:00"), photographerId: harrison.id, statusEvidence: RAWS_IN,
    },
    select: { id: true },
  });
  const dJ2 = await prisma.deliverable.create({ data: { projectId: J2.id, type: "VIDEO", label: "Real Estate Video Tour", quantity: 1 }, select: { id: true } });
  await sweep(J2.id);
  ok("it starts out blocked, as it should", !!(await card(J2.id))?.blockedReason && !!(await proj(J2.id)).handoffBlockedReason);
  await prisma.reviewSubmission.create({
    data: { projectId: J2.id, kind: "video", deliverableId: dJ2.id, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "107-old-baltimore-v1.mp4" },
  });
  await sweep(J2.id);
  const cJ2 = await card(J2.id);
  const pJ2 = await proj(J2.id);
  ok("once the cut is in the Review Room the card stops chasing a brief", cJ2?.blockedReason === null && cJ2?.followUpAt === null,
    `${String(cJ2?.blockedReason)} / ${et(cJ2?.followUpAt)}`);
  ok("…and the delivery board's stored blocker stops arguing with it", pJ2.handoffBlockedReason === null && pJ2.handoffOwnerKey === null,
    `${String(pJ2.handoffBlockedReason)} / ${String(pJ2.handoffOwnerKey)}`);
  const board2d = await opsExceptionsBoard({ now: nowDate() });
  ok("no unclearable follow-up row is left behind", board2d.totals["overdue-followup"].all === 0, JSON.stringify(board2d.totals["overdue-followup"]));

  console.log("\n2e. THE SAME JOB, PUT ON HOLD WHILE THE CHASE IS RUNNING");
  // The hourly cron's own gate, verbatim (projectStatus.ts: the handoff runs
  // only `if (["SHOT","EDITING","REVIEW"].includes(final))`). Everything above
  // called ensureEditorHandoff directly, which is the sweep's BODY; this is the
  // sweep's DOOR, and the difference is the whole point of this section.
  const { closeTasksOnInactiveProjects } = await import("@/lib/tasks");
  const hourlySweep = async (id: string) => {
    const st = (await proj(id)).status;
    if (["SHOT", "EDITING", "REVIEW"].includes(st)) await ensureEditorHandoff(id);
    await closeTasksOnInactiveProjects();
  };
  const J2e = await prisma.project.create({
    data: {
      title: "1462 Brandywine Ln, West Chester, PA", addressLine: "1462 Brandywine Ln",
      clientId: client.id, status: "EDITING", source: "ARYEO", aryeoOrderId: "ord-j2e",
      shootDate: new RealDate("2026-09-23T14:00:00-04:00"), photographerId: harrison.id, statusEvidence: RAWS_IN,
    },
    select: { id: true },
  });
  await prisma.deliverable.create({ data: { projectId: J2e.id, type: "VIDEO", label: "Real Estate Video Tour", quantity: 1 } });
  await hourlySweep(J2e.id);
  const armed2e = await card(J2e.id);
  ok("it is blocked and the chase is armed", !!armed2e?.blockedReason && !!armed2e?.followUpAt, et(armed2e?.followUpAt));
  for (let h = 0; h < 96; h++) { advanceHours(1); await hourlySweep(J2e.id); }
  const board2eA = await opsExceptionsBoard({ now: nowDate() });
  ok("four days later it is on the board, as designed", board2eA.rows.some((r) => r.id === `followup:${armed2e!.id}`),
    `${board2eA.totals["overdue-followup"].all} follow-up row(s)`);

  // The office parks the job — a re-shoot is being booked, the client went
  // quiet, whatever. Nothing about the missing brief changed.
  await prisma.project.update({ where: { id: J2e.id }, data: { status: "ON_HOLD" } });
  await hourlySweep(J2e.id);
  ok("the card survives the hold (it is real work, only paused)", (await card(J2e.id))?.status === "OPEN", (await card(J2e.id))?.status ?? "gone");

  // …and now the thing the chase was asking for actually arrives.
  await prisma.project.update({
    where: { id: J2e.id },
    data: {
      videoInstructions: "VISION FOR THE EDIT\nOpen wide on the drive, hold the great room, close on the pond.",
      debriefSubmittedAt: nowDate(),
    },
  });
  for (let h = 0; h < 72; h++) { advanceHours(1); await hourlySweep(J2e.id); }
  const c2e = await card(J2e.id);
  const board2eB = await opsExceptionsBoard({ now: nowDate() });
  const row2e = board2eB.rows.find((r) => r.id === `followup:${armed2e!.id}`);
  ok("THE ANSWERED BLOCKER CLEARS EVEN WHILE THE JOB IS ON HOLD", c2e?.blockedReason === null && c2e?.followUpAt === null,
    `blocker=${String(c2e?.blockedReason)} chase=${et(c2e?.followUpAt)}`);
  ok("…so the exception board lets the row go", !row2e, row2e ? `still there: ${row2e.severity}, ${row2e.ageDays} days — "${row2e.why}"` : "gone");
  ok("…and the project row stops naming a blocker too", (await proj(J2e.id)).handoffBlockedReason === null, String((await proj(J2e.id)).handoffBlockedReason));
  if ((await card(J2e.id))?.followUpAt) {
    note("The only writer that can clear followUpAt is this block, and the cron's door");
    note("(projectStatus.ts:1821) only opens for SHOT / EDITING / REVIEW. ON_HOLD and");
    note("REVISION are outside it, so a chase armed before the move ages on the board");
    note("with no screen in the hub able to set or clear the field — the exact shape");
    note("073a6f5 cured on three cards, through a door it did not close.");
  }

  // Put it back to work and the sweep can reach it again.
  await prisma.project.update({ where: { id: J2e.id }, data: { status: "EDITING" } });
  await hourlySweep(J2e.id);
  const c2eBack = await card(J2e.id);
  ok("back in the editing lane, the sweep does clear it", c2eBack?.blockedReason === null && c2eBack?.followUpAt === null,
    `blocker=${String(c2eBack?.blockedReason)} chase=${et(c2eBack?.followUpAt)}`);
  const board2eC = await opsExceptionsBoard({ now: nowDate() });
  ok("…and only then does the board go quiet", !board2eC.rows.some((r) => r.id === `followup:${armed2e!.id}`),
    `${board2eC.totals["overdue-followup"].all} follow-up row(s)`);

  console.log("\n2f. THE OTHER CLOSED DOOR (REVISION), AND THE HOUR BEFORE THE JANITOR RUNS");
  // ON_HOLD is not the only status outside the handoff sweep's door: a job
  // bounced to REVISION is swept for status and skipped for handoff, so a chase
  // armed before the bounce is just as unreachable. And the janitor runs on the
  // hour — a job parked at ten past must not spend the next fifty minutes
  // escalating on the owner's card either, which is the board's own job.
  const J2f = await prisma.project.create({
    data: {
      title: "88 Kirkwood Dr, Downingtown, PA", addressLine: "88 Kirkwood Dr",
      clientId: client.id, status: "EDITING", source: "ARYEO", aryeoOrderId: "ord-j2f",
      shootDate: new RealDate("2026-09-23T14:00:00-04:00"), photographerId: harrison.id, statusEvidence: RAWS_IN,
    },
    select: { id: true },
  });
  await prisma.deliverable.create({ data: { projectId: J2f.id, type: "VIDEO", label: "Real Estate Video Tour", quantity: 1 } });
  await hourlySweep(J2f.id);
  const armed2f = await card(J2f.id);
  ok("it is blocked and the chase is armed", !!armed2f?.blockedReason && !!armed2f?.followUpAt, et(armed2f?.followUpAt));
  for (let h = 0; h < 96; h++) { advanceHours(1); await hourlySweep(J2f.id); }
  ok("four days later it is on the board, as designed",
    (await opsExceptionsBoard({ now: nowDate() })).rows.some((r) => r.id === `followup:${armed2f!.id}`));

  // Parked at ten past the hour. No janitor yet — this is the board alone.
  await prisma.project.update({ where: { id: J2f.id }, data: { status: "ON_HOLD" } });
  const boardParked = await opsExceptionsBoard({ now: nowDate() });
  ok("A PARKED JOB STOPS ESCALATING THE MOMENT IT IS PARKED, before any sweep runs",
    !boardParked.rows.some((r) => r.id === `followup:${armed2f!.id}`),
    `${boardParked.totals["overdue-followup"].all} follow-up row(s)`);
  ok("…and that is the BOARD refusing it, not the data having changed", !!(await card(J2f.id))?.followUpAt, et((await card(J2f.id))?.followUpAt));

  // Off hold and straight into REVISION — live work again, so the row is back.
  await prisma.project.update({ where: { id: J2f.id }, data: { status: "REVISION" } });
  ok("a job in REVISION is live work, so the chase counts again",
    (await opsExceptionsBoard({ now: nowDate() })).rows.some((r) => r.id === `followup:${armed2f!.id}`));
  await prisma.project.update({
    where: { id: J2f.id },
    data: {
      videoInstructions: "VISION FOR THE EDIT\nOpen on the porch, hold the kitchen, close on the garden.",
      debriefSubmittedAt: nowDate(),
    },
  });
  advanceHours(1);
  await hourlySweep(J2f.id);
  const c2f = await card(J2f.id);
  ok("THE ANSWERED BLOCKER CLEARS IN REVISION TOO, where the handoff sweep never runs",
    c2f?.blockedReason === null && c2f?.followUpAt === null,
    `blocker=${String(c2f?.blockedReason)} chase=${et(c2f?.followUpAt)}`);
  ok("…and the project row stops naming a blocker with it", (await proj(J2f.id)).handoffBlockedReason === null,
    String((await proj(J2f.id)).handoffBlockedReason));
  ok("…and the board lets the row go", !(await opsExceptionsBoard({ now: nowDate() })).rows.some((r) => r.id === `followup:${armed2f!.id}`));

  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("JOURNEY 3 — the sync finding raw files is not a photographer handing the job in");
  console.log("-".repeat(78));
  setNow("2026-09-21T11:00:00-04:00");

  const mkShoot = async (title: string, shootDate: Date, video: boolean, evidence: string | null = RAWS_IN) => {
    const p = await prisma.project.create({
      data: {
        title, addressLine: title.split(",")[0], clientId: client.id, status: "SHOT", source: "ARYEO",
        aryeoOrderId: `ord-${title.slice(0, 6).replace(/\W/g, "")}`, shootDate, photographerId: harrison.id,
        // THE SWEEP'S OWN STAMP: uploadedAt written off a Dropbox file count
        // (projectStatus.ts rawsDetected / dropboxFolders.ts syncDropboxFolderStatus),
        // with no human submit anywhere near it.
        uploadedAt: new Date(shootDate.getTime() + 3 * 3_600_000),
        debriefSubmittedAt: null,
        statusEvidence: evidence,
      },
      select: { id: true },
    });
    await prisma.deliverable.create({ data: { projectId: p.id, type: "PHOTOS", label: "Professional Photography", quantity: 1 } });
    if (video) await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Real Estate Video Tour", quantity: 1 } });
    return p.id;
  };

  console.log("\n3a. A POST-PAY-GATE SHOOT the sweep stamped before the photographer pressed Submit");
  const J3 = await mkShoot("5642 Limeport Rd, Emmaus, PA", new RealDate("2026-09-19T13:00:00-04:00"), true);
  const pre3 = await proj(J3);
  ok("the fixture is the real shape: raws stamped, nothing submitted", !!pre3.uploadedAt && !pre3.debriefSubmittedAt, `uploadedAt ${et(pre3.uploadedAt)}`);
  ok("…and it is after the Sep 2 pay gate", new RealDate("2026-09-19T13:00:00-04:00").getTime() >= DEBRIEF_PAY_GATE_FROM);
  const r3a = await finalizeUpload(J3, { editorBrief: "" });
  ok("THE SERVER STILL DEMANDS THE FIRST HUMAN SUBMIT", !!r3a.blocked, r3a.blocked ?? "(not blocked)");
  ok("…and it asks for the cull, the step that comes first", /cull/i.test(r3a.blocked ?? ""), r3a.blocked ?? "");
  ok("nothing was recorded as submitted", !(await proj(J3)).debriefSubmittedAt);

  console.log("\n3b. THE NEXT GATES, ONE AT A TIME — each is still reachable behind a sweep-stamped uploadedAt");
  const r3b1 = await finalizeUpload(J3, { editorBrief: "", cullingConfirmed: true });
  ok("the shot order is still demanded", /shot order|refresh this page/i.test(r3b1.blocked ?? ""), r3b1.blocked ?? "");
  const r3b2 = await finalizeUpload(J3, { editorBrief: "", cullingConfirmed: true, shotOrder: { mode: "front-to-back" } });
  ok("the removal notes are still demanded", /removal/i.test(r3b2.blocked ?? ""), r3b2.blocked ?? "");
  const r3b3 = await finalizeUpload(J3, { editorBrief: "", cullingConfirmed: true, shotOrder: { mode: "front-to-back" }, nothingToRemove: true });
  ok("the video instructions are still demanded", /instructions|vision/i.test(r3b3.blocked ?? ""), r3b3.blocked ?? "");
  ok("still nothing recorded as submitted", !(await proj(J3)).debriefSubmittedAt);
  const boilerplate = "STYLE: Cinematic\nCOLOR PROFILE: iPhone\nVISION FOR THE EDIT\nSUMMARY\nADDITIONAL NOTES";
  const r3b4 = await finalizeUpload(J3, {
    editorBrief: "", cullingConfirmed: true, shotOrder: { mode: "front-to-back" }, nothingToRemove: true,
    videoInstructions: boilerplate,
  });
  ok("boilerplate headings do not satisfy the brief", !!r3b4.blocked, r3b4.blocked ?? "(accepted the boilerplate)");

  console.log("\n3c. THE REAL SUBMIT GOES THROUGH, and the handoff runs off the photographer's words");
  DBX.mode = "files";
  DBX.files = [{ name: "A7R_0001.ARW", tag: "file", path: "/x/A7R_0001.ARW" }, { name: "clip01.mp4", tag: "file", path: "/x/clip01.mp4" }];
  const r3c = await finalizeUpload(J3, {
    editorBrief: "", cullingConfirmed: true, shotOrder: { mode: "front-to-back" }, nothingToRemove: true,
    videoInstructions: "STYLE: Cinematic\nVISION FOR THE EDIT\nSlow push through the entry, linger on the stone fireplace, finish on the creek.",
  });
  ok("the submit is accepted", !r3c.blocked && !r3c.needsConfirm, r3c.blocked ?? r3c.warning ?? "accepted");
  const p3c = await proj(J3);
  ok("the human submit is stamped", !!p3c.debriefSubmittedAt, et(p3c.debriefSubmittedAt));
  await sweep(J3);
  const c3c = await card(J3);
  ok("the editor's card is not blocked on a brief that now exists", c3c?.blockedReason === null, String(c3c?.blockedReason));
  ok("…and carries no chase date", c3c?.followUpAt === null, et(c3c?.followUpAt));

  console.log("\n3d. RE-SUBMITS AND LEGACY SHOOTS ARE NOT TRAPPED");
  const r3d = await finalizeUpload(J3, { editorBrief: "Tighten the kitchen section." });
  ok("a re-submit is never asked for retroactive debrief answers", !r3d.blocked, r3d.blocked ?? "accepted");
  const J3L = await mkShoot("18 Legacy Ln, Coatesville, PA", new RealDate("2026-08-20T13:00:00-04:00"), false);
  const r3L = await finalizeUpload(J3L, { editorBrief: "" });
  ok("a PRE-pay-gate shoot with no submit step keeps its escape hatch", !r3L.blocked, r3L.blocked ?? "accepted");
  const J3N = await mkShoot("9 Newer Way, Exton, PA", new RealDate("2026-09-17T13:00:00-04:00"), false);
  await prisma.project.update({ where: { id: J3N }, data: { uploadedAt: null } });
  const r3N = await finalizeUpload(J3N, { editorBrief: "" });
  ok("a post-pay-gate photo job with no stamp at all is still gated", !!r3N.blocked, r3N.blocked ?? "(not blocked)");

  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("JOURNEY 4 — a photo-only job that ran past its promise");
  console.log("-".repeat(78));
  setNow("2026-09-21T11:00:00-04:00");

  // The shoot happened, the raws are in, and NOTHING is on the client's listing
  // yet — the honest shape of a photo job that has run past its promise.
  const PHOTOS_NOT_OUT = JSON.stringify({
    expected: ["Photos", "Drone"], present: [], missing: ["Photos", "Drone"], awaitingSend: [], units: [],
    aryeo: { photos: 0, videos: 0, floorPlans: 0, interactive: 0, delivery: null },
    dropbox: { rawPhotos: 143, rawVideo: 0, finalPhotos: 0, finalVideo: 0, stale: false },
    reason: "Photos not on the listing yet",
  });
  // The listing looks complete — the shape that used to let a REVISION job slip
  // out of being late.
  const PHOTOS_ALL_OUT = JSON.stringify({
    expected: ["Photos", "Drone"], present: ["Photos", "Drone"], missing: [], awaitingSend: [], units: [],
    aryeo: { photos: 42, videos: 0, floorPlans: 0, interactive: 0, delivery: "delivered" },
    dropbox: { rawPhotos: 143, rawVideo: 0, finalPhotos: 42, finalVideo: 0, stale: false },
    fulfilledOnAryeo: true, reason: "Everything ordered is on the listing",
  });
  const mkPhotoJob = async (title: string, over: Partial<{ status: string; debriefSubmittedAt: Date | null; shootDate: Date | null; evidence: string }> = {}) => {
    const p = await prisma.project.create({
      data: {
        title, addressLine: title.split(",")[0], clientId: client.id,
        status: (over.status ?? "SHOT") as "SHOT", source: "ARYEO", aryeoOrderId: `ord-${Math.random().toString(36).slice(2, 8)}`,
        shootDate: over.shootDate === undefined ? new RealDate("2026-09-16T13:00:00-04:00") : over.shootDate,
        photographerId: harrison.id,
        // The promise has already gone by.
        promisedDueAt: new RealDate("2026-09-18T17:00:00-04:00"),
        deliveryDue: new RealDate("2026-09-18T17:00:00-04:00"),
        debriefSubmittedAt: over.debriefSubmittedAt === undefined ? new RealDate("2026-09-16T18:00:00-04:00") : over.debriefSubmittedAt,
        statusEvidence: over.evidence ?? PHOTOS_NOT_OUT,
      },
      select: { id: true },
    });
    await prisma.deliverable.create({ data: { projectId: p.id, type: "PHOTOS", label: "Professional Photography", productTitle: "Professional Photography", quantity: 1 } });
    await prisma.deliverable.create({ data: { projectId: p.id, type: "DRONE", label: "Aerial Photos", productTitle: "Aerial Photos", quantity: 1 } });
    await prisma.orderItem.create({ data: { projectId: p.id, title: "Professional Photography", amount: 25000 } });
    return p.id;
  };

  const J4 = await mkPhotoJob("1217 River Rd, Washington Crossing, PA");
  console.log("\n4a. THE CARD, BEFORE ANY SWEEP");
  const b4 = (await projectBrief(J4))!;
  ok("the card renders at all", !!b4);
  ok("NO VIDEO SCRIPT IS DEMANDED of a stills order", !/flow and vision|script|intro/i.test(b4.blocker ?? ""), b4.blocker ?? "(no blocker)");
  ok("…and the next action is photo work, not editing vision", /photos|listing|send/i.test(b4.nextAction), b4.nextAction);
  ok("the owner is the office, not the photographer who already wrapped up", b4.owner.whose === "office", `${b4.owner.who} (${b4.owner.whose})`);
  ok("OVERDUE IS REACHABLE — it is past its promise and it says so", b4.overdue === true, `promised ${et(b4.promisedAt)}, overdue=${b4.overdue}`);
  ok("there are no per-video rows to reach it through", b4.outputs.length === 0, `${b4.outputs.length} output rows`);
  ok("the promise is labelled as a photo promise", !/video/i.test(b4.tone.headline ?? ""), b4.tone.headline ?? "");

  console.log("\n4b. THE BACKGROUND SWEEP RUNS OVER IT");
  await sweep(J4);
  const p4 = await proj(J4);
  ok("the handoff engine writes no video blocker onto a photo job", p4.handoffBlockedReason === null, String(p4.handoffBlockedReason));
  ok("…and mints no editor card", (await card(J4)) === null);
  ok("…and no 'find the raw video' chase", (await prisma.smartTask.count({ where: { dedupeKey: `raw-video-missing-${J4}` } })) === 0);
  const b4b = (await projectBrief(J4))!;
  ok("the card reads the same after the sweep", b4b.overdue === true && b4b.nextAction === b4.nextAction, `${b4b.nextAction} / overdue=${b4b.overdue}`);
  const board4 = await opsExceptionsBoard({ now: nowDate() });
  ok("it never lands on 'Nobody assigned' — photos have no editor lane",
    !board4.rows.some((r) => r.kind === "unassigned" && r.id === `unassigned:${J4}`),
    `${board4.totals.unassigned.all} unassigned rows on the board, none of them this job`);

  console.log("\n4c. THE OTHER PHOTO SHAPES");
  const J4b = await mkPhotoJob("20 Thompson Mill Rd, Newtown, PA", { debriefSubmittedAt: null });
  const b4c = (await projectBrief(J4b))!;
  ok("a shot-but-not-wrapped-up job asks for the wrap-up, from the photographer", /wrap-up/i.test(b4c.nextAction) && b4c.owner.whose === "field", `${b4c.owner.who}: ${b4c.nextAction}`);
  const J4c = await mkPhotoJob("265 Koser Rd, Lititz, PA", { shootDate: null, debriefSubmittedAt: null, status: "BOOKED" });
  const b4d = (await projectBrief(J4c))!;
  ok("a job with no shoot date is the OFFICE's, not the photographer's", b4d.owner.whose === "office" && /shoot date/i.test(b4d.nextAction), `${b4d.owner.who}: ${b4d.nextAction}`);
  const J4d = await mkPhotoJob("88 Cancelled Ct, Exton, PA", { status: "CANCELLED" });
  const b4e = (await projectBrief(J4d))!;
  ok("a cancelled order is never late and is nobody's", b4e.overdue === false && b4e.owner.whose === "nobody", `overdue=${b4e.overdue}, ${b4e.owner.who}`);
  const J4e = await mkPhotoJob("84 Longfellow Cir, Downingtown, PA", { status: "REVISION", evidence: PHOTOS_ALL_OUT });
  const b4f = (await projectBrief(J4e))!;
  ok("a photo job in REVISION past its date is late even if the listing looks clear", b4f.overdue === true, `overdue=${b4f.overdue}, tone=${b4f.tone.kind}`);
  ok("…and is told to make the photo fixes", /photo fixes/i.test(b4f.nextAction), b4f.nextAction);

  // =========================================================================
  console.log("\n" + "-".repeat(78));
  console.log("JOURNEY 5 — an interrupted upload, and a provider outage");
  console.log("-".repeat(78));
  setNow("2026-09-21T11:00:00-04:00");
  await saveSecret("dropbox", "drill-refresh-token-not-a-real-one");

  const J5 = await mkShoot("41 Outage Rd, Malvern, PA", new RealDate("2026-09-19T13:00:00-04:00"), true);
  const j5row = await prisma.project.findUniqueOrThrow({
    where: { id: J5 },
    select: { title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, client: { select: { name: true } } },
  });
  const paths = actualFolderPaths(j5row);

  console.log("\n5a. THE TWO KINDS OF ZERO");
  DBX.mode = "missing";
  const missingCount = await folderFileCount(paths.rawPhotos);
  ok("a folder that does not exist is a TRUSTWORTHY zero", missingCount === 0, `count=${String(missingCount)}`);
  DBX.mode = "outage";
  const outageCount = await folderFileCount(paths.rawPhotos);
  ok("A FOLDER WE COULD NOT READ IS NOT A ZERO — it is unknown", outageCount === null, `count=${String(outageCount)}`);
  DBX.mode = "outage";
  const outageVideo = await videoFilesUnder(paths.listing);
  ok("…and the video search says unknown too, not 'no video files'", outageVideo === null, JSON.stringify(outageVideo));
  DBX.mode = "missing";
  const missingVideo = await videoFilesUnder(paths.listing);
  ok("a missing folder really does mean no video files", missingVideo?.count === 0, JSON.stringify(missingVideo));

  console.log("\n5b. WHAT THE PHOTOGRAPHER'S PAGE SAYS DURING AN OUTAGE");
  DBX.mode = "outage";
  const state = (await getProjectFolderState(j5row))!;
  ok("the page knows the read failed", state.readFailed === true);
  ok("EVERY COUNT IS UNKNOWN, none of them is 0", state.folders.every((f) => f.count === null), state.folders.map((f) => `${f.label}=${String(f.count)}`).join(", "));
  ok("…so it cannot claim the raws are in", state.hasRaw === false);
  ok("…and cannot claim the finals are in either", state.hasFinal === false);
  DBX.mode = "files";
  DBX.files = [{ name: "A7R_0001.ARW", tag: "file", path: "/x/A7R_0001.ARW" }];
  const stateOk = (await getProjectFolderState(j5row))!;
  ok("when the read works, it reports real numbers", stateOk.readFailed === false && stateOk.hasRaw === true, stateOk.folders.map((f) => `${f.label}=${String(f.count)}`).join(", "));

  console.log("\n5c. THE FOLDER SWEEP DOES NOT ADVANCE A JOB IT COULD NOT LOOK AT");
  const J5b = await prisma.project.create({
    data: {
      title: "7 Blip Ln, Phoenixville, PA", addressLine: "7 Blip Ln", clientId: client.id, status: "SCHEDULED",
      source: "ARYEO", aryeoOrderId: "ord-j5b", shootDate: new RealDate("2026-09-19T13:00:00-04:00"), photographerId: harrison.id,
    },
    select: { id: true },
  });
  await prisma.deliverable.create({ data: { projectId: J5b.id, type: "PHOTOS", label: "Professional Photography", quantity: 1 } });
  DBX.mode = "outage";
  const swept = await syncDropboxFolderStatus();
  const after5c = await proj(J5b.id);
  ok("the sweep looked at the job", swept.checked > 0, `${swept.checked} checked`);
  ok("NOTHING WAS MOVED TO SHOT on an unreadable folder", swept.movedToShot === 0 && after5c.status === "SCHEDULED", `${after5c.status}, movedToShot=${swept.movedToShot}`);
  ok("…and no 'raws landed' was stamped", !after5c.uploadedAt, et(after5c.uploadedAt));
  ok("…and no timeline row claims files were detected",
    (await prisma.activity.count({ where: { projectId: J5b.id, body: { contains: "detected in Dropbox" } } })) === 0);

  console.log("\n5d. THE HANDOFF ENGINE ON A CARRIED-FORWARD (STALE) ZERO");
  const J5c = await prisma.project.create({
    data: {
      title: "3 Stale Ct, Berwyn, PA", addressLine: "3 Stale Ct", clientId: client.id, status: "SHOT", source: "ARYEO",
      aryeoOrderId: "ord-j5c", shootDate: new RealDate("2026-09-19T13:00:00-04:00"), photographerId: harrison.id,
      // Last night's read, carried forward because this pass could not reach Dropbox.
      statusEvidence: JSON.stringify({ present: [], dropbox: { rawPhotos: 0, rawVideo: 0, finalVideo: 0, stale: true, readError: "too_many_requests" } }),
    },
    select: { id: true },
  });
  await prisma.deliverable.create({ data: { projectId: J5c.id, type: "VIDEO", label: "Real Estate Video Tour", quantity: 1 } });
  await sweep(J5c.id);
  ok("no editor work is minted off footage nobody could confirm", (await card(J5c.id)) === null);
  ok("…and the photographer is not chased for footage that may well be there",
    (await prisma.smartTask.count({ where: { dedupeKey: `raw-video-missing-${J5c.id}` } })) === 0);
  ok("…and no blocker sentence is invented", (await proj(J5c.id)).handoffBlockedReason === null);

  console.log("\n5e. AN INTERRUPTED UPLOAD AT THE SUBMIT — the folder is genuinely empty");
  const J5d = await mkShoot("55 Halfway Dr, Paoli, PA", new RealDate("2026-09-19T13:00:00-04:00"), true);
  await prisma.project.update({ where: { id: J5d }, data: { uploadedAt: null } });
  DBX.mode = "missing"; // a real, readable zero
  const r5e = await finalizeUpload(J5d, {
    editorBrief: "", cullingConfirmed: true, shotOrder: { mode: "front-to-back" }, nothingToRemove: true,
    videoInstructions: "VISION FOR THE EDIT\nSlow push through the entry.",
  });
  ok("THE SUBMIT DOES NOT COMPLETE — it bounces back for a confirm", r5e.needsConfirm === true, JSON.stringify(r5e));
  ok("…and says which folder is empty", /RAW-Photos folder is empty|no video files/i.test(r5e.warning ?? ""), r5e.warning ?? "");
  ok("…and suggests the upload may still be running", /still running|give Dropbox a minute/i.test(r5e.warning ?? ""), r5e.warning ?? "");
  ok("nothing was recorded as submitted", !(await proj(J5d)).debriefSubmittedAt);

  console.log("\n5f. THE SAME SUBMIT DURING AN OUTAGE — unknown is not proof of absence");
  const J5e = await mkShoot("61 Blackout Way, Berwyn, PA", new RealDate("2026-09-19T13:00:00-04:00"), true);
  await prisma.project.update({ where: { id: J5e }, data: { uploadedAt: null } });
  DBX.mode = "outage";
  const r5f = await finalizeUpload(J5e, {
    editorBrief: "", cullingConfirmed: true, shotOrder: { mode: "front-to-back" }, nothingToRemove: true,
    videoInstructions: "VISION FOR THE EDIT\nSlow push through the entry.",
  });
  ok("the photographer is not accused of an empty folder the hub could not read", !r5f.needsConfirm, JSON.stringify(r5f));
  ok("…and no timeline row invents a file count", (await prisma.activity.count({ where: { projectId: J5e, body: { startsWith: "Upload check" } } })) === 0);
  const p5f = await proj(J5e);
  ok("the human's own word is what completes the submit", !!p5f.debriefSubmittedAt, et(p5f.debriefSubmittedAt));
  DBX.mode = "outage";
  const state5f = (await getProjectFolderState(
    await prisma.project.findUniqueOrThrow({ where: { id: J5e }, select: { title: true, addressLine: true, shootDate: true, createdAt: true, dropboxFolder: true, client: { select: { name: true } } } }),
  ))!;
  ok("…while the machine's own surface still says it could not verify", state5f.readFailed === true && state5f.folders.every((f) => f.count === null));

  console.log(`\n${"=".repeat(78)}`);
  console.log(`Dropbox reads served by the stub: ${DBX.reads}. Outbound calls blocked: ${blockedCalls}.`);
  console.log(fail === 0 ? `ALL CHECKS PASSED (${pass} passed)` : `${fail} FAILED, ${pass} passed`);
  if (fail > 0) failures.forEach((f) => console.log(`  ✗ ${f}`));
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
