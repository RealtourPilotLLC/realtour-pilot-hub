// ---------------------------------------------------------------------------
// DRILL B1: EXPLICIT EDITOR WORK STATE (§7.1, unified handoff Sep 25 2026).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/b1-active-editing.ts
//
// Drives the SHIPPED code (lib/editorWork, the queue pill, the override, the
// reassign/remove/put-back paths, the upload finalize, the delivery/cancel
// closer, the readers) against an isolated PGlite on 127.0.0.1:5601.
// Production is never opened; every outbound call is fenced and counted.
//
//   §0  OLD behaviour, from commit 75d56f1 (never HEAD): the office's pill
//       click logged as the editor, two jobs claimed "In editing" at once, the
//       workload lane called "In editing", the tracker's "In the edit" off the
//       status alone, a withdrawn cut writing EDITING.
//   §1  A65  historical EDITING rows: derived, never backfilled; one confirm
//   §2  A59/A62 + logging: the switch, pause/resume touching nothing else,
//            one event + one timeline row per transition, replays write zero
//   §3  A59  a failed start leaves the previous job exactly as it was
//   §4  A60  concurrent starts, a doubled click, the P2002 backstop
//   §5  A61  per-editor identity, on-behalf corrections, refusals
//   §6  7.1-revision-semantics
//   §7  A63  submit / reassign / remove / deliver / cancel / put-back / ghost
//   §8  A58  no automatic path starts or resumes work
//   §9  A64  every reader agrees; a failed read says so
//
// THE CLOCK IS PINNED to Tuesday Sep 22 2026, 10:00 ET, and runs forward from
// there: nothing here may depend on the day this is run (three drills broke on
// Sep 25 for reading the real clock).
//
// WHAT PGLITE CANNOT PROVE. It is one backend session: two transactions never
// interleave, they queue. §4 therefore proves the invariants under real
// concurrent CALLS (both in flight at once, serialized by the session) and
// forces the one interleaving the advisory lock exists to prevent with a
// trigger. True interleaving on regular Postgres is the R04 harness's job and
// is printed as NOT PROVABLE HERE.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Module from "node:module";
import type { Prisma } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5601);
const BASE = "75d56f1";
const REPO = path.resolve(__dirname, "../..");
const DAY = 86_400_000;

// ---- the pinned clock ----------------------------------------------------
const RealDate = Date;
const PARK = RealDate.UTC(2026, 8, 22, 14, 0, 0); // Tue Sep 22 2026 10:00 ET
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
const advance = (ms: number) => { clockOffsetMs += ms; };

installNextStubs();
const fence = fenceFetch();
// The tracker's icons: lucide-react builds a React context at import time,
// which the react-server build of React does not have. The drill only calls
// the tracker's pure deriveEditStage, so the icons are stubbed.
{
  const L = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = L._load;
  L._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "lucide-react") return new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : () => null) });
    return prev.call(this, request, parent, isMain);
  };
}

// ---- old code, pinned to BASE --------------------------------------------
// The file as it was at BASE, with "@/…" pointed at this checkout's src/ (so
// the old function runs against the same database client and today's
// neighbours), written under node_modules/.cache so bare imports resolve and
// nothing lands in the working tree.
const BASE_DIR = path.join(REPO, "node_modules/.cache", `b1-baseline-${BASE}`);
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
  const work = await import("@/lib/editorWork");
  const editing = await import("@/app/editing/actions");
  const appActions = await import("@/app/actions");
  const tasks = await import("@/lib/tasks");
  const reviewCuts = await import("@/lib/reviewCuts");
  const { buildEditorQueue } = await import("@/lib/editorQueue");
  const { LANE_LABEL, laneOf } = await import("@/lib/editorWorkload");
  const { deriveEditStage } = await import("@/components/editing/EditTracker");
  const { setSession } = await import("@/lib/auth/session");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");

  // ---- the world -----------------------------------------------------------
  const client = await prisma.client.create({ data: { name: "Drill Agent" }, select: { id: true } });
  const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
  const kimTm = await prisma.teamMember.create({ data: { name: "Kim Miguel", email: "kim@drill.invalid", role: "EDITOR" }, select: { id: true } });
  const johnTm = await prisma.teamMember.create({ data: { name: "John Mark", email: "john@drill.invalid", role: "EDITOR" }, select: { id: true } });
  const mkUser = (email: string, name: string, role: string, editorKey: string | null = null) =>
    prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", editorKey }, select: { id: true, email: true, name: true, role: true } });
  const jordan = await mkUser("jordan@drill.invalid", "Jordan Spackman", "OWNER");
  const kyle = await mkUser("kyle@drill.invalid", "Kyle Cabrera", "ADMIN");
  const kim = await mkUser("kimm@drill.invalid", "Kim Miguel", "EDITOR", "kim");
  const john = await mkUser("johnm@drill.invalid", "John Mark", "EDITOR", "john");
  const shooter = await mkUser("harrison@drill.invalid", "Harrison Wells", "PHOTOGRAPHER");
  type U = { id: string; email: string; name: string | null; role: string };
  const as = (u: U, actingAs?: U) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined, ...(actingAs ? { actingAs: actingAs.id } : {}) });

  let seq = 0;
  type Job = { id: string; street: string; deliverableId: string; cardId: string | null };
  const mkJob = async (o: {
    street: string;
    status: "BOOKED" | "SCHEDULED" | "SHOT" | "EDITING" | "REVIEW" | "REVISION" | "DELIVERED" | "CANCELLED";
    editor: "kim" | "john" | "external_agency" | null;
    cardStatus?: "OPEN" | "IN_PROGRESS";
    videos?: number;
    raws?: boolean;
  }): Promise<Job> => {
    const p = await prisma.project.create({
      data: {
        title: `${o.street}, Royersford, PA`, clientId: client.id, status: o.status, aryeoOrderId: `drill-${++seq}`,
        shootDate: new Date(Date.now() - 3 * DAY), photographerId: harrison.id, payableInvoice: 400, price: 400,
        editorId: o.editor === "kim" ? kimTm.id : o.editor === "john" ? johnTm.id : null,
        statusEvidence: o.raws ? JSON.stringify({ present: ["Photos"], missing: ["Video"], dropbox: { rawVideo: 12, rawPhotos: 40, finalVideo: 0 } }) : null,
      },
      select: { id: true },
    });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Standard Reel", quantity: o.videos ?? 1 }, select: { id: true } });
    const card = await prisma.smartTask.create({
      // assignedManually: a person put this editor on the card, so the hourly
      // routing refresh (mintEditTask) keeps it where the fixture says.
      data: { taskType: "edit_video", title: `Edit — ${o.street}`, status: o.cardStatus ?? "OPEN", assignedKey: o.editor, assignedManually: !!o.editor, projectId: p.id, clientId: client.id, dedupeKey: `edit-video-${p.id}` },
      select: { id: true },
    });
    return { id: p.id, street: o.street, deliverableId: d.id, cardId: card.id };
  };
  const item = (editorKey: string, projectId: string) => prisma.editorWorkItem.findUnique({ where: { editorKey_projectId: { editorKey, projectId } } });
  const activeOf = (editorKey: string) => prisma.editorWorkItem.findMany({ where: { editorKey, state: "ACTIVE" } });
  const events = (where: Prisma.EditorWorkEventWhereInput = {}) => prisma.editorWorkEvent.count({ where });
  const lines = (projectId: string, needle: string) => prisma.activity.count({ where: { projectId, body: { contains: needle } } });
  const status = async (id: string) => (await prisma.project.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
  const rowOf = async (id: string) => {
    const q = await buildEditorQueue();
    return [...q.notDone, ...q.upcoming, ...q.done].find((r) => r.id === id) ?? null;
  };

  // =========================================================================
  c.head(`§0 · the OLD behaviour, from ${BASE}`);
  // =========================================================================
  const oldWorkload = (await import(baseline("src/lib/editorWorkload.ts"))) as typeof import("@/lib/editorWorkload");
  c.ok("old: the workload lane that folds Ready for editing and Revisions was LABELLED \"In editing\"",
    oldWorkload.LANE_LABEL.editing === "In editing" && oldWorkload.laneOf("Ready for editing") === "editing" && oldWorkload.laneOf("Revisions") === "editing",
    `LANE_LABEL.editing = "${oldWorkload.LANE_LABEL.editing}"`);
  const oldTracker = (await import(baseline("src/components/editing/EditTracker.tsx"))) as typeof import("@/components/editing/EditTracker");
  const oldStage = oldTracker.deriveEditStage({ projectStatus: "EDITING", revisionOpen: false, revisionAfterApproval: false, latestRoundStatus: null, rawsLanded: true });
  c.ok("old: the tracker said \"In the edit\" off Project.status alone — nobody had to press anything", oldStage.label === "In the edit — footage is in", oldStage.label);
  const oldCuts = (await import(baseline("src/lib/reviewCuts.ts"))) as typeof import("@/lib/reviewCuts");
  // No editor on its card, so this EDITING row is nobody's claim in §1.
  const W1 = await mkJob({ street: "1 Withdrawn Old Ln", status: "REVIEW", editor: null });
  await oldCuts.correctedCutWithdrawn(W1.id);
  c.ok("old: a withdrawn cut with no ask open wrote EDITING — \"someone is in the edit\" from an office take-back", (await status(W1.id)) === "EDITING");

  // The old pill, as the office, on Kim's job while another of her jobs is
  // already "In editing". These three become §1's historical claims.
  const oldActions = (await import(baseline("src/app/editing/actions.ts"))) as typeof import("@/app/editing/actions");
  const L1 = await mkJob({ street: "11 Legacy Rd", status: "SHOT", editor: "kim", raws: true });
  const L2 = await mkJob({ street: "22 Legacy Rd", status: "SHOT", editor: "kim", raws: true });
  const L3 = await mkJob({ street: "33 Legacy Rd", status: "EDITING", editor: "kim", cardStatus: "IN_PROGRESS" });
  await as(kim);
  const oldKim = await oldActions.setQueueStatus(L2.id, "In editing");
  await as(jordan);
  const oldOffice = await oldActions.setQueueStatus(L1.id, "In editing");
  c.ok("old: both pill clicks landed", oldKim.ok && oldOffice.ok, `${oldKim.message} / ${oldOffice.message}`);
  const claimed = await prisma.project.count({ where: { id: { in: [L1.id, L2.id, L3.id] }, status: "EDITING" } });
  c.ok("old: starting one job paused nothing — Kim held THREE jobs \"In editing\" at once", claimed === 3, `${claimed} EDITING`);
  c.ok("old: Jordan's click was logged as \"Kim started editing.\" — the real actor recorded nowhere",
    (await lines(L1.id, "Kim started editing.")) === 1 && (await lines(L1.id, "Jordan")) === 0);
  c.ok("old: no per-editor record was written (the table exists, the old code never touches it)", (await prisma.editorWorkItem.count()) === 0);

  // =========================================================================
  c.head("§1 · A65 historical EDITING rows: derived, not backfilled, confirmed once");
  // =========================================================================
  const payrollOf = async () => {
    try {
      const { computePayroll } = await import("@/lib/payroll");
      const r = await computePayroll(new Date(Date.now() - 10 * DAY), new Date(Date.now() + DAY));
      return JSON.stringify(r);
    } catch (e) {
      return `unavailable: ${(e as Error).message.slice(0, 80)}`;
    }
  };
  const payBefore = await payrollOf();
  const itemsBefore = await prisma.editorWorkItem.count();
  const wn1 = await work.workingNow();
  const kimDesk1 = wn1.ok ? wn1.editors.find((e) => e.key === "kim") : null;
  c.ok("reading Working now creates zero rows", (await prisma.editorWorkItem.count()) === itemsBefore && itemsBefore === 0);
  c.ok("Kim shows 3 unconfirmed claims, nothing active", !!kimDesk1 && kimDesk1.unconfirmed.length === 3 && kimDesk1.active === null,
    kimDesk1 ? kimDesk1.unconfirmed.map((u) => u.street).join(", ") : "no desk");
  const claimDates = new Map(kimDesk1?.unconfirmed.map((u) => [u.projectId, u.claimedAt]) ?? []);
  c.ok("the two claims with a \"started editing.\" line carry that line's date; the one without has none (no invented start)",
    !!claimDates.get(L1.id) && !!claimDates.get(L2.id) && claimDates.get(L3.id) === null);
  const r1 = await rowOf(L3.id);
  c.ok("the queue row reads \"In editing — not confirmed\"", r1?.status === "In editing — not confirmed", r1?.status);
  await as(kim);
  const kimDesk = await work.myDesk("kim");
  c.ok("Kim's own desk asks about the same 3", kimDesk.unconfirmed.length === 3 && kimDesk.active === null);
  const conf = await work.confirmCurrentWork({ projectId: L2.id, requestId: "confirm-1" });
  c.ok("confirmCurrentWork(L2) lands", conf.ok, conf.message);
  const [i1, i2, i3] = await Promise.all([item("kim", L1.id), item("kim", L2.id), item("kim", L3.id)]);
  c.ok("L2 ACTIVE with firstStartedAt = the confirm, not a guess", i2?.state === "ACTIVE" && i2.activeFor === "kim" && !!i2.firstStartedAt && Math.abs(i2.firstStartedAt.getTime() - Date.now()) < 60_000);
  c.ok("L1 and L3 PAUSED with firstStartedAt null (never started in this layer)", i1?.state === "PAUSED" && i3?.state === "PAUSED" && !i1.firstStartedAt && !i3.firstStartedAt);
  c.ok("one CONFIRM and two CONFIRM_PAUSED events", (await events({ kind: "CONFIRM" })) === 1 && (await events({ kind: "CONFIRM_PAUSED" })) === 2);
  const st1 = await prisma.project.findMany({ where: { id: { in: [L1.id, L2.id, L3.id] } }, select: { status: true } });
  c.ok("Project.status unchanged on all three (still EDITING)", st1.every((p) => p.status === "EDITING"));
  const evBeforeReplay = await events();
  const conf2 = await work.confirmCurrentWork({ projectId: L2.id, requestId: "confirm-1" });
  c.ok("the same confirm again writes nothing", conf2.ok && (await events()) === evBeforeReplay, conf2.message);
  const payAfter = await payrollOf();
  c.ok("payroll for the fixture period is identical before and after", payBefore === payAfter && !payBefore.startsWith("unavailable"), payBefore.startsWith("unavailable") ? payBefore : `${payBefore.length} chars`);
  const wn2 = await work.workingNow();
  const kd2 = wn2.ok ? wn2.editors.find((e) => e.key === "kim") : null;
  c.ok("Working now: Kim on L2, L1 + L3 paused, nothing left to confirm",
    kd2?.active?.projectId === L2.id && kd2.paused.length === 2 && kd2.unconfirmed.length === 0);

  // =========================================================================
  c.head("§2 · A59/A62 the switch, pause and resume, and the log");
  // =========================================================================
  const A = await mkJob({ street: "100 Alpha St", status: "SHOT", editor: "kim", raws: true });
  const B = await mkJob({ street: "200 Bravo St", status: "SHOT", editor: "kim", raws: true });
  const bellsA0 = await prisma.notification.count({ where: { kind: "edit_started" } });
  advance(60_000);
  const sA = await work.startEditing({ projectId: A.id, requestId: "start-A" });
  c.ok("Kim starts A", sA.ok, sA.message);
  const iA = await item("kim", A.id);
  const cardA = await prisma.smartTask.findUniqueOrThrow({ where: { id: A.cardId! } });
  // (the fixture's card is hand-pinned; Start itself no longer sets the flag — §R #2)
  c.ok("A: ACTIVE, Ready for editing → EDITING, card IN_PROGRESS and still Kim's",
    iA?.state === "ACTIVE" && (await status(A.id)) === "EDITING" && cardA.status === "IN_PROGRESS" && cardA.assignedManually && cardA.assignedKey === "kim");
  c.ok("L2 (where she was) auto-paused, switchedTo = A", (await item("kim", L2.id))?.state === "PAUSED" && (await events({ projectId: L2.id, kind: "AUTO_PAUSE", switchedTo: A.id })) === 1);
  c.ok("timeline: \"Kim started editing (paused 22 Legacy Rd).\" on A; one line on L2", (await lines(A.id, "Kim started editing (paused 22 Legacy Rd).")) === 1 && (await lines(L2.id, "Kim's editing paused — switched to 100 Alpha St.")) === 1);
  c.ok("one bell for the start", (await prisma.notification.count({ where: { kind: "edit_started" } })) === bellsA0 + 1);
  advance(60_000);
  const sB = await work.startEditing({ projectId: B.id, requestId: "start-B" });
  const [iA2, iB] = await Promise.all([item("kim", A.id), item("kim", B.id)]);
  c.ok("Kim starts B: A PAUSED with pausedAt, B ACTIVE", sB.ok && iA2?.state === "PAUSED" && !!iA2.pausedAt && iA2.activeFor === null && iB?.state === "ACTIVE", sB.message);
  c.ok("one AUTO_PAUSE on A with switchedTo = B, one START on B", (await events({ projectId: A.id, kind: "AUTO_PAUSE", switchedTo: B.id })) === 1 && (await events({ projectId: B.id, kind: "START" })) === 1);
  c.ok("exactly one ACTIVE for Kim", (await activeOf("kim")).length === 1);
  const evB = await events({ projectId: B.id });
  const linesB = await prisma.activity.count({ where: { projectId: B.id } });
  const retries = await Promise.all([1, 2, 3].map(() => work.startEditing({ projectId: B.id, requestId: "start-B" })));
  c.ok("the same click ×3 is a replay: zero events, zero timeline rows", retries.every((r) => r.ok && r.replay) && (await events({ projectId: B.id })) === evB && (await prisma.activity.count({ where: { projectId: B.id } })) === linesB, retries[0].message);
  const again = await work.startEditing({ projectId: B.id, requestId: "start-B-second-tab" });
  c.ok("a second tab starting B again is a no-op (no event)", again.ok && (await events({ projectId: B.id })) === evB, again.message);

  // A62 — pause/resume touch nothing but the work layer.
  const revB = await prisma.smartTask.create({
    data: { taskType: "revision", title: "Video revision — 200 Bravo St", status: "OPEN", assignedKey: "kim", projectId: B.id, clientId: client.id, summary: "Client: make the music quieter" },
    select: { id: true },
  });
  await prisma.project.update({ where: { id: B.id }, data: { deliveryDue: new Date(Date.now() + 2 * DAY), promisedDueAt: new Date(Date.now() + 3 * DAY), dueOverrideAt: new Date(Date.now() + 4 * DAY) } });
  await ensureOutputsForProject(B.id);
  const snap = async () => JSON.stringify({
    card: await prisma.smartTask.findUniqueOrThrow({ where: { id: B.cardId! }, select: { status: true, assignedKey: true, dueAt: true, summary: true, description: true } }),
    rev: await prisma.smartTask.findUniqueOrThrow({ where: { id: revB.id }, select: { status: true, summary: true, assignedKey: true } }),
    proj: await prisma.project.findUniqueOrThrow({ where: { id: B.id }, select: { status: true, deliveryDue: true, promisedDueAt: true, dueOverrideAt: true } }),
    outs: await prisma.deliverableOutput.findMany({ where: { projectId: B.id }, select: { promisedAt: true, targetAt: true, ownerKey: true }, orderBy: { slot: "asc" } }),
  });
  const before = await snap();
  const firstStarted = (await item("kim", B.id))!.firstStartedAt!.getTime();
  const activeSince0 = (await item("kim", B.id))!.activeSince!.getTime();
  const ev0 = await events({ projectId: B.id });
  advance(5 * 60_000);
  const pB = await work.pauseEditing({ projectId: B.id, requestId: "pause-B" });
  const pB2 = await work.pauseEditing({ projectId: B.id, requestId: "pause-B-again" });
  c.ok("pause B; pausing it again writes nothing", pB.ok && pB2.ok && (await events({ projectId: B.id, kind: "PAUSE" })) === 1, `${pB.message} / ${pB2.message}`);
  c.ok("timeline: \"Kim paused editing.\"", (await lines(B.id, "Kim paused editing.")) === 1);
  c.ok("Kim has nothing active now", (await activeOf("kim")).length === 0);
  const bellsBeforeResume = await prisma.notification.count({ where: { kind: "edit_started" } });
  advance(5 * 60_000);
  const rsB = await work.startEditing({ projectId: B.id, requestId: "resume-B" });
  const iB2 = await item("kim", B.id);
  c.ok("resume B: RESUME event, firstStartedAt kept, activeSince newer", rsB.ok && (await events({ projectId: B.id, kind: "RESUME" })) === 1 && iB2!.firstStartedAt!.getTime() === firstStarted && iB2!.activeSince!.getTime() > activeSince0, rsB.message);
  c.ok("a resume rings nobody (the bell is for a START)", (await prisma.notification.count({ where: { kind: "edit_started" } })) === bellsBeforeResume);
  c.ok("card, revision ask, project dates and output promises are byte-for-byte unchanged by pause + resume", (await snap()) === before);
  c.ok("each transition wrote exactly one event (pause + resume = 2)", (await events({ projectId: B.id })) === ev0 + 2);

  // =========================================================================
  c.head("§3 · A59 a start that fails leaves the previous job untouched");
  // =========================================================================
  const sinceB = (await item("kim", B.id))!.activeSince!.getTime();
  const evAll = await events();
  const C = await mkJob({ street: "300 Cancelled Ct", status: "CANCELLED", editor: "kim" });
  const sC = await work.startEditing({ projectId: C.id, requestId: "start-C" });
  c.ok("B's start on a CANCELLED job is refused before the transaction", !sC.ok && (await item("kim", C.id)) === null, sC.message);
  const D = await mkJob({ street: "400 Delta Dr", status: "SHOT", editor: "kim" });
  // A real failure AFTER the pause of B is written, inside the same
  // transaction: activating D raises. The pause must roll back with it.
  await prisma.$executeRawUnsafe(`CREATE TABLE drill_fail (project text NOT NULL)`);
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION drill_fail_item() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM drill_fail WHERE project = NEW."projectId") THEN RAISE EXCEPTION 'drill: activating this job failed'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER drill_fail_item BEFORE INSERT OR UPDATE ON "EditorWorkItem" FOR EACH ROW EXECUTE FUNCTION drill_fail_item()`);
  await prisma.$executeRawUnsafe(`INSERT INTO drill_fail VALUES ('${D.id}')`);
  const sD = await work.startEditing({ projectId: D.id, requestId: "start-D" });
  await prisma.$executeRawUnsafe(`DELETE FROM drill_fail`);
  const iBafter = await item("kim", B.id);
  c.ok("the start is refused with \"nothing changed\"", !sD.ok && /nothing changed/.test(sD.message), sD.message);
  c.ok("B is still ACTIVE with the SAME activeSince", iBafter?.state === "ACTIVE" && iBafter.activeFor === "kim" && iBafter.activeSince!.getTime() === sinceB);
  c.ok("D has no row, no events were written, D is still Ready for editing with an OPEN card",
    (await item("kim", D.id)) === null && (await events()) === evAll && (await status(D.id)) === "SHOT" &&
      (await prisma.smartTask.findUniqueOrThrow({ where: { id: D.cardId! } })).status === "OPEN");

  // =========================================================================
  c.head("§4 · A60 two tabs, a doubled click, and the P2002 backstop");
  // =========================================================================
  const E = await mkJob({ street: "500 Echo Ave", status: "SHOT", editor: "kim" });
  const F = await mkJob({ street: "600 Foxtrot Ave", status: "SHOT", editor: "kim" });
  const [tE, tF] = await Promise.all([
    work.startEditing({ projectId: E.id, requestId: "tab-E" }),
    work.startEditing({ projectId: F.id, requestId: "tab-F" }),
  ]);
  const act = await activeOf("kim");
  const [iE, iF] = await Promise.all([item("kim", E.id), item("kim", F.id)]);
  c.ok("two tabs start two jobs at once: both answer, exactly ONE is active", tE.ok && tF.ok && act.length === 1 && [E.id, F.id].includes(act[0].projectId), `active: ${act.map((a) => a.projectId === E.id ? "E" : "F").join(",")}`);
  c.ok("the other of the two is PAUSED (the later start paused it), B paused too",
    [iE?.state, iF?.state].sort().join(",") === "ACTIVE,PAUSED" && (await item("kim", B.id))?.state === "PAUSED");
  const G = await mkJob({ street: "700 Golf Ln", status: "SHOT", editor: "kim" });
  const dbl = await Promise.all([work.startEditing({ projectId: G.id, requestId: "dbl-G" }), work.startEditing({ projectId: G.id, requestId: "dbl-G" })]);
  c.ok("a doubled click (same requestId, both in flight): one START, one replay, one ACTIVE",
    dbl.every((r) => r.ok) && dbl.filter((r) => r.replay).length === 1 && (await events({ projectId: G.id, kind: "START" })) === 1 && (await activeOf("kim")).length === 1);

  // The interleaving the per-editor lock exists to prevent: a racing tab's
  // start lands BETWEEN this start's pause of G and its activation of H.
  // Real Postgres, lockless, gives exactly this unique violation; PGlite can
  // only produce it with a trigger standing in for the other tab.
  const H = await mkJob({ street: "800 Hotel Rd", status: "SHOT", editor: "kim" });
  const R = await mkJob({ street: "900 Racing Tab Rd", status: "SHOT", editor: "kim" });
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION drill_race() RETURNS trigger AS $$
    BEGIN
      IF OLD."state" = 'ACTIVE' AND NEW."state" = 'PAUSED' AND EXISTS (SELECT 1 FROM drill_fail WHERE project = 'race') THEN
        INSERT INTO "EditorWorkItem" ("id","editorKey","projectId","state","activeFor","activeSince","firstStartedAt","lastEventAt","createdAt","updatedAt")
        VALUES ('racing-tab', NEW."editorKey", '${R.id}', 'ACTIVE', NEW."editorKey", now(), now(), now(), now(), now());
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER drill_race AFTER UPDATE ON "EditorWorkItem" FOR EACH ROW EXECUTE FUNCTION drill_race()`);
  await prisma.$executeRawUnsafe(`INSERT INTO drill_fail VALUES ('race')`);
  const sinceG = (await item("kim", G.id))!.activeSince!.getTime();
  const evRace = await events();
  const sH = await work.startEditing({ projectId: H.id, requestId: "start-H" });
  await prisma.$executeRawUnsafe(`DELETE FROM drill_fail`);
  // The refresh answer is returned ONLY for a P2002 (editorWork.isP2002).
  c.ok("the racing start's unique violation (P2002 on activeFor) is caught and answered \"refresh\"", !sH.ok && /refresh/i.test(sH.message), sH.message);
  const iG = await item("kim", G.id);
  c.ok("the whole switch rolled back: G still ACTIVE, same activeSince; H has no row; no events", iG?.state === "ACTIVE" && iG.activeSince!.getTime() === sinceG && (await item("kim", H.id)) === null && (await events()) === evRace);
  c.ok("still exactly one ACTIVE for Kim", (await activeOf("kim")).length === 1);
  let direct = "";
  try {
    await prisma.editorWorkItem.create({ data: { editorKey: "kim", projectId: H.id, state: "ACTIVE", activeFor: "kim", lastEventAt: new Date() } });
    direct = "inserted";
  } catch (e) {
    direct = (e as { code?: string }).code ?? "error";
  }
  c.ok("a direct second ACTIVE row for Kim is refused by the database (P2002)", direct === "P2002", direct);
  c.ok("…and the connection survives it", (await prisma.editorWorkItem.count({ where: { editorKey: "kim" } })) > 0);
  console.log("  NOT PROVABLE HERE two transactions truly interleaving on regular Postgres\n      PGlite is one session; the advisory lock (dbLocks.lockAdvisory 'editor-desk:<key>') and activeFor @unique are the guards. Deferred to the R04 disposable-Postgres harness.");

  // =========================================================================
  c.head("§5 · A61 per-editor identity, office corrections, refusals");
  // =========================================================================
  const J1 = await mkJob({ street: "1 Juliet Way", status: "SHOT", editor: "john", videos: 2 });
  await ensureOutputsForProject(J1.id);
  const outs = await prisma.deliverableOutput.findMany({ where: { projectId: J1.id }, orderBy: { slot: "asc" }, select: { id: true } });
  await prisma.deliverableOutput.update({ where: { id: outs[1].id }, data: { ownerKey: "kim", ownerName: "Kim" } });
  await as(john);
  const jStart = await work.startEditing({ projectId: J1.id, requestId: "john-J1" });
  const sinceJ = (await item("john", J1.id))!.activeSince!.getTime();
  await as(kim);
  const K1 = await mkJob({ street: "2 Kilo Way", status: "SHOT", editor: "kim" });
  await work.startEditing({ projectId: K1.id, requestId: "kim-K1" });
  advance(60_000);
  const kJ1 = await work.startEditing({ projectId: J1.id, outputId: outs[1].id, requestId: "kim-J1" });
  const [ij, ik, ikK1] = await Promise.all([item("john", J1.id), item("kim", J1.id), item("kim", K1.id)]);
  c.ok("John active on J1; Kim (who owns video 2) starts J1 too", jStart.ok && kJ1.ok, `${jStart.message} / ${kJ1.message}`);
  c.ok("John's J1 stays ACTIVE with the SAME activeSince — Kim's start never touches John", ij?.state === "ACTIVE" && ij.activeSince!.getTime() === sinceJ);
  c.ok("Kim's own K1 paused; her J1 item carries the video she picked", ikK1?.state === "PAUSED" && ik?.state === "ACTIVE" && ik.outputId === outs[1].id);
  const rowJ1 = await rowOf(J1.id);
  c.ok("the row reads \"In editing\" naming both", rowJ1?.status === "In editing" && rowJ1.work.active.length === 2 && /Kim/.test(rowJ1.workChip ?? "") && /John Mark/.test(rowJ1.workChip ?? ""), `${rowJ1?.status} · ${rowJ1?.workChip}`);
  const J2 = await mkJob({ street: "3 John Only Way", status: "SHOT", editor: "john" });
  const kJ2 = await work.startEditing({ projectId: J2.id, requestId: "kim-J2" });
  c.ok("Kim (EDITOR) starting John's job is refused", !kJ2.ok && (await item("kim", J2.id)) === null, kJ2.message);
  const forged = await work.startEditing({ projectId: J2.id, forEditorKey: "john", requestId: "kim-J2-forged" });
  c.ok("…and naming John as forEditorKey does not help an editor", !forged.ok && (await item("john", J2.id)) === null, forged.message);
  await as(jordan);
  const oJ2 = await work.startEditing({ projectId: J2.id, requestId: "office-J2" });
  const evO = await prisma.editorWorkEvent.findFirst({ where: { projectId: J2.id, kind: "START" } });
  c.ok("the office starts J2 for John: onBehalf, actor = Jordan (OWNER)", oJ2.ok && evO?.onBehalf === true && evO.actorName === "Jordan Spackman" && evO.actorRole === "OWNER" && evO.editorKey === "john", oJ2.message);
  c.ok("the timeline names both people and says it was a correction", (await lines(J2.id, "Jordan Spackman started editing for John Mark (office correction)")) === 1);
  c.ok("the bell says who did it", (await prisma.notification.count({ where: { title: { contains: "Jordan Spackman started 3 John Only Way for John Mark" } } })) === 1);
  c.ok("John's J1 was auto-paused by that start (one active per editor, whoever pressed)", (await item("john", J1.id))?.state === "PAUSED" && (await activeOf("john")).length === 1);
  await as(kyle);
  const kP = await work.pauseEditing({ projectId: J2.id, requestId: "kyle-pause-J2" });
  const evK = await prisma.editorWorkEvent.findFirst({ where: { projectId: J2.id, kind: "PAUSE" } });
  c.ok("Kyle (ADMIN) pauses J2 for John: recorded as Kyle, on John's behalf", kP.ok && evK?.onBehalf === true && evK.actorName === "Kyle Cabrera" && evK.actorRole === "ADMIN" && (await lines(J2.id, "Kyle Cabrera paused John Mark's editing (office correction).")) === 1, kP.message);
  const X = await mkJob({ street: "4 Agency Pl", status: "SHOT", editor: "external_agency" });
  const oX = await work.startEditing({ projectId: X.id, requestId: "office-X" });
  c.ok("a vendor (the external agency — no login) can't be marked active", !oX.ok && (await prisma.editorWorkItem.count({ where: { projectId: X.id } })) === 0, oX.message);
  await as(jordan, kim);
  const va = await work.startEditing({ projectId: K1.id, requestId: "viewas-K1" });
  c.ok("view-as (Jordan previewing Kim) is refused", !va.ok && /previewing/.test(va.message), va.message);
  await as(shooter);
  const ph = await work.startEditing({ projectId: K1.id, requestId: "photog-K1" });
  c.ok("a photographer is refused", !ph.ok, ph.message);

  // =========================================================================
  c.head("§6 · a revision can be active without stopping being a revision");
  // =========================================================================
  const V = await mkJob({ street: "5 Victor Blvd", status: "REVISION", editor: "kim" });
  const revV = await prisma.smartTask.create({
    data: { taskType: "revision", title: "Video revision — 5 Victor Blvd", status: "IN_PROGRESS", assignedKey: "kim", projectId: V.id, clientId: client.id, summary: "Client ask: swap the song · corrected cut submitted — waiting on review" },
    select: { id: true, status: true, summary: true },
  });
  await prisma.project.update({ where: { id: V.id }, data: { revisionRequestedAt: new Date(Date.now() - DAY) } });
  await prisma.reviewSubmission.create({ data: { projectId: V.id, kind: "video", deliverableId: V.deliverableId, slot: 1, round: 1, status: "CHANGES_REQUESTED", source: "upload", fileName: "v1.mp4", submittedByKey: "kim" } });
  await as(kim);
  const sV = await work.startEditing({ projectId: V.id, requestId: "kim-V" });
  const revAfter = await prisma.smartTask.findUniqueOrThrow({ where: { id: revV.id }, select: { status: true, summary: true } });
  c.ok("start on a REVISION job: status stays REVISION", sV.ok && (await status(V.id)) === "REVISION", sV.message);
  c.ok("the revision task's status and summary are untouched (its IN_PROGRESS means \"waiting on review\")", revAfter.status === revV.status && revAfter.summary === revV.summary);
  const rowV = await rowOf(V.id);
  c.ok("the row reads Revisions with an \"Active — Kim\" chip", rowV?.status === "Revisions" && /^Active — Kim/.test(rowV.workChip ?? ""), `${rowV?.status} · ${rowV?.workChip}`);

  // =========================================================================
  c.head("§7 · A63 submit, reassign, remove, deliver, cancel, put back, ghosts");
  // =========================================================================
  const M = await mkJob({ street: "6 Mike St", status: "SHOT", editor: "kim", videos: 4 });
  await ensureOutputsForProject(M.id);
  await work.startEditing({ projectId: M.id, requestId: "kim-M" });
  const up = await prisma.reviewSubmission.create({
    data: { projectId: M.id, kind: "video", deliverableId: M.deliverableId, slot: 1, round: 1, status: "UPLOADING", source: "upload", fileName: "mike-video1-v1.mp4", submittedByKey: "kim", submittedByName: "Kim Miguel" },
    select: { id: true },
  });
  const fin = await reviewCuts.finalizeCutUpload(up.id, {
    url: `https://drillstore.public.blob.vercel-storage.com/review-cuts/${M.id}/${up.id}/mike-video1-v1.mp4`,
    pathname: `review-cuts/${M.id}/${up.id}/mike-video1-v1.mp4`,
    size: 1234,
  });
  const iM = await item("kim", M.id);
  c.ok("cut 1 of 4 uploaded through the portal finalize", fin.ok, fin.message);
  c.ok("Kim's item on M is CLOSED(SUBMITTED) with a SUBMIT event", iM?.state === "CLOSED" && iM.closeReason === "SUBMITTED" && (await events({ projectId: M.id, kind: "SUBMIT" })) === 1);
  c.ok("the edit card is still open (3 videos still owed)", !["COMPLETED", "CANCELLED"].includes((await prisma.smartTask.findUniqueOrThrow({ where: { id: M.cardId! } })).status));
  c.ok("no output was marked approved or delivered by the submit", (await prisma.deliverableOutput.count({ where: { projectId: M.id, OR: [{ approvedSubmissionId: { not: null } }, { deliveredAt: { not: null } }] } })) === 0);
  const rowM = await rowOf(M.id);
  c.ok("the row reads Ready for review, \"1 ready for review · 3 more to edit\"", rowM?.status === "Ready for review" && rowM.videoBreakdown === "1 ready for review · 3 more to edit", `${rowM?.status} · ${rowM?.videoBreakdown}`);
  const reM = await work.startEditing({ projectId: M.id, requestId: "kim-M-video2" });
  c.ok("the next video is a fresh Start (not a resume)", reM.ok && (await events({ projectId: M.id, kind: "START" })) === 2, reM.message);
  await as(jordan);
  const reas = await editing.setEditVideoEditor(M.id, "john");
  const iM2 = await item("kim", M.id);
  c.ok("reassigned to John: Kim's item CLOSED(REASSIGNED), recorded as the office", reas.ok && iM2?.state === "CLOSED" && iM2.closeReason === "REASSIGNED" && (await lines(M.id, "reassigned to John Mark by Jordan Spackman")) === 1, reas.message);
  c.ok("John is NOT started on it", (await item("john", M.id)) === null);

  const N = await mkJob({ street: "7 November Ct", status: "SHOT", editor: "kim" });
  await as(kim);
  await work.startEditing({ projectId: N.id, requestId: "kim-N" });
  await as(jordan);
  await editing.removeFromEditorQueue(N.id, "drill");
  c.ok("taken off the Editing Room: CLOSED(REMOVED), no ACTIVE on N", (await item("kim", N.id))?.closeReason === "REMOVED" && (await prisma.editorWorkItem.count({ where: { projectId: N.id, state: "ACTIVE" } })) === 0);
  const restored = await editing.restoreToEditorQueue(N.id);
  c.ok("restored: the CARD comes back, the work stays closed (the editor presses Resume)", restored.ok && (await item("kim", N.id))?.state === "CLOSED" && (await prisma.smartTask.findUniqueOrThrow({ where: { id: N.cardId! } })).status === "IN_PROGRESS");

  const P = await mkJob({ street: "8 Papa Rd", status: "SHOT", editor: "kim" });
  const Q = await mkJob({ street: "9 Quebec Rd", status: "SHOT", editor: "kim" });
  const Rb = await mkJob({ street: "10 Romeo Rd", status: "SHOT", editor: "kim" });
  await as(kim);
  await work.startEditing({ projectId: P.id, requestId: "kim-P" });
  await work.startEditing({ projectId: Q.id, requestId: "kim-Q" });
  await work.startEditing({ projectId: Rb.id, requestId: "kim-R" });
  await as(jordan);
  await appActions.moveProjectStatus(P.id, "DELIVERED");
  c.ok("the board's Delivered closes P (PROJECT_DELIVERED), as the hub", (await item("kim", P.id))?.closeReason === "PROJECT_DELIVERED" && (await prisma.editorWorkItem.count({ where: { projectId: P.id, state: "ACTIVE" } })) === 0);
  await tasks.closeObsoleteTasks(Q.id, "CANCELLED");
  c.ok("the Aryeo-cancel closer closes Q (PROJECT_CANCELLED)", (await item("kim", Q.id))?.closeReason === "PROJECT_CANCELLED");
  const back = await editing.setQueueStatus(Rb.id, "Ready for editing");
  c.ok("the office's put-back closes R (PUT_BACK) and the job reads Ready for editing", back.ok && (await item("kim", Rb.id))?.closeReason === "PUT_BACK" && (await status(Rb.id)) === "SHOT", back.message);

  // A path this batch does not own (the task card's assignee) moves the job:
  // the reader leaves the ghost out at once, the hourly card refresh closes it.
  const S = await mkJob({ street: "11 Sierra Rd", status: "SHOT", editor: "kim" });
  await as(kim);
  await work.startEditing({ projectId: S.id, requestId: "kim-S" });
  await as(jordan);
  await appActions.setTaskAssignee(S.cardId!, "john");
  const ghostRead = (await work.workStateFor([S.id])).get(S.id);
  c.ok("after a task-card reassign the readers already leave Kim off S", !ghostRead);
  await tasks.mintEditTask(S.id);
  c.ok("…and the next card refresh closes her item as REASSIGNED (system)", (await item("kim", S.id))?.closeReason === "REASSIGNED" && (await activeOf("kim")).length === 0);

  // =========================================================================
  c.head("§8 · A58 no automatic path creates or resumes work");
  // =========================================================================
  const T1 = await mkJob({ street: "12 Tango Rd", status: "SHOT", editor: "kim", raws: true });
  const T2 = await mkJob({ street: "13 Uniform Rd", status: "SHOT", editor: "john", raws: true });
  const T3 = await mkJob({ street: "14 Whiskey Rd", status: "REVIEW", editor: "kim" });
  const startsBefore = await events({ kind: { in: ["START", "RESUME", "CONFIRM"] } });
  const activeBefore = await prisma.editorWorkItem.count({ where: { state: "ACTIVE" } });
  const rowsBefore = await prisma.editorWorkItem.count({ where: { projectId: { in: [T1.id, T2.id, T3.id] } } });
  const ran: string[] = [];
  const tryRun = async (label: string, f: () => Promise<unknown>) => {
    try { await f(); ran.push(label); } catch (e) { ran.push(`${label} (threw: ${(e as Error).message.slice(0, 60)})`); }
  };
  await as(jordan);
  await tryRun("notifyRawsLanded", () => tasks.notifyRawsLanded(T1.id));
  await tryRun("ensureEditorHandoff", () => tasks.ensureEditorHandoff(T1.id));
  await tryRun("mintEditTask", () => tasks.mintEditTask(T2.id));
  await tryRun("syncProjectStatuses", async () => (await import("@/lib/projectStatus")).syncProjectStatuses({ projectId: T1.id }));
  await tryRun("setEditVideoEditor", () => editing.setEditVideoEditor(T2.id, "kim"));
  await tryRun("assignMember(editor)", () => appActions.assignMember(T1.id, "editor", johnTm.id));
  await tryRun("correctedCutWithdrawn", () => reviewCuts.correctedCutWithdrawn(T3.id));
  await tryRun("saveEditOverrides(In editing)", () => editing.saveEditOverrides(T1.id, { status: "In editing" } as never));
  await tryRun("moveProjectStatus(EDITING)", () => appActions.moveProjectStatus(T2.id, "EDITING"));
  await tryRun("removeFromEditorQueue+restore", async () => { await editing.removeFromEditorQueue(T2.id); await editing.restoreToEditorQueue(T2.id); });
  await as(kim);
  await tryRun("setSmartTaskStatus(IN_PROGRESS) as the assigned editor", () => appActions.setSmartTaskStatus(T1.cardId!, "IN_PROGRESS"));
  c.ok(`ran ${ran.length} paths, none refused or threw`, ran.length === 11 && ran.every((r) => !r.includes("(threw")), ran.join(" · "));
  c.ok("no ACTIVE item and no START/RESUME/CONFIRM event came out of any of them",
    (await prisma.editorWorkItem.count({ where: { state: "ACTIVE" } })) === activeBefore &&
      (await events({ kind: { in: ["START", "RESUME", "CONFIRM"] } })) === startsBefore &&
      (await prisma.editorWorkItem.count({ where: { projectId: { in: [T1.id, T2.id, T3.id] } } })) === rowsBefore);
  c.ok("the withdrawn cut now leaves the job Ready for editing (SHOT), not EDITING", (await status(T3.id)) === "SHOT");
  const rowT1 = await rowOf(T1.id);
  c.ok("the office's In-editing PIN is only the stage: the row reads \"In editing — not confirmed\"", rowT1?.status === "In editing — not confirmed", rowT1?.status);
  const sT1 = await work.startEditing({ projectId: T1.id, requestId: "kim-T1" });
  c.ok("then the assigned editor's own Start: exactly 1 new ACTIVE and 1 START", sT1.ok &&
    (await prisma.editorWorkItem.count({ where: { projectId: T1.id, state: "ACTIVE" } })) === 1 && (await events({ projectId: T1.id, kind: "START" })) === 1, sT1.message);

  // =========================================================================
  c.head("§9 · A64 every reader tells the same story; a failed read says so");
  // =========================================================================
  const X1 = await mkJob({ street: "21 Xray Rd", status: "SHOT", editor: "john" });
  const X2 = await mkJob({ street: "22 Yankee Rd", status: "EDITING", editor: "john", cardStatus: "IN_PROGRESS" });
  const X4 = await mkJob({ street: "24 Zulu Rd", status: "SHOT", editor: "john", videos: 4 });
  await prisma.reviewSubmission.create({ data: { projectId: X4.id, kind: "video", deliverableId: X4.deliverableId, slot: 1, round: 1, status: "APPROVED", decidedAt: new Date(), source: "upload", fileName: "z1.mp4", submittedByKey: "john" } });
  const X5 = await mkJob({ street: "25 Alpha Two Rd", status: "REVIEW", editor: "john" });
  await prisma.reviewSubmission.create({ data: { projectId: X5.id, kind: "video", deliverableId: X5.deliverableId, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "a2.mp4", submittedByKey: "john" } });
  const q = await buildEditorQueue();
  const all = [...q.notDone, ...q.upcoming, ...q.done];
  const lab = (id: string) => all.find((r) => r.id === id);
  c.ok("X1 SHOT, nobody: Ready for editing", lab(X1.id)?.status === "Ready for editing", lab(X1.id)?.status);
  c.ok("X2 EDITING, nobody: In editing — not confirmed", lab(X2.id)?.status === "In editing — not confirmed", lab(X2.id)?.status);
  c.ok("X4 4-video, 1 approved, nobody on it: Ready for editing (was \"In editing\"), \"1 approved · 3 more to edit\"",
    lab(X4.id)?.status === "Ready for editing" && lab(X4.id)?.videoBreakdown === "1 approved · 3 more to edit", `${lab(X4.id)?.status} · ${lab(X4.id)?.videoBreakdown}`);
  c.ok("X5 cut pending: Ready for review", lab(X5.id)?.status === "Ready for review", lab(X5.id)?.status);
  const liars = all.filter((r) => r.status === "In editing" && r.work.active.length === 0);
  c.ok("no queue row reads \"In editing\" without somebody ACTIVE", liars.length === 0, liars.map((r) => r.street).join(", ") || `${all.filter((r) => r.status === "In editing").length} honest`);
  const vs = await reviewCuts.videoStatesFor([X1.id, X2.id, X4.id, X5.id, V.id, T1.id]);
  c.ok("video state (Ops Day / Kyle's QC card): X1 Ready for editing, X2 not confirmed, X4 \"1 of 4 handed in\"",
    /^Ready for editing/.test(vs.get(X1.id)?.detail ?? "") && /^In editing — not confirmed/.test(vs.get(X2.id)?.detail ?? "") && /^1 of 4 handed in/.test(vs.get(X4.id)?.detail ?? ""),
    [X1, X2, X4].map((x) => vs.get(x.id)?.detail).join(" | "));
  c.ok("video state: T1 (Kim pressed Start) reads \"In editing — Kim since …\"", /^In editing — Kim since /.test(vs.get(T1.id)?.detail ?? ""), vs.get(T1.id)?.detail);
  // "In editing — <name> since …" is only ever written for an ACTIVE person.
  const badVs = [...vs.values()].filter((v) => /^In editing/.test(v.detail) && !/not confirmed/.test(v.detail) && !/ since /.test(v.detail));
  c.ok("no video-state line says \"In editing\" without somebody ACTIVE, except \"not confirmed\"", badVs.length === 0, badVs.map((v) => v.detail).join(" | "));
  const stNone = deriveEditStage({ projectStatus: "EDITING", revisionOpen: false, revisionAfterApproval: false, latestRoundStatus: null, rawsLanded: true, work: null });
  const stAct = deriveEditStage({ projectStatus: "EDITING", revisionOpen: false, revisionAfterApproval: false, latestRoundStatus: null, rawsLanded: true, work: "active" });
  const stPau = deriveEditStage({ projectStatus: "EDITING", revisionOpen: false, revisionAfterApproval: false, latestRoundStatus: null, rawsLanded: true, work: "paused" });
  const stShot = deriveEditStage({ projectStatus: "SHOT", revisionOpen: false, revisionAfterApproval: false, latestRoundStatus: null, rawsLanded: true, work: null });
  c.ok("the edit page's tracker: \"In the edit\" only when active; paused says Paused; EDITING alone says not confirmed",
    stAct.label === "In the edit — footage is in" && stPau.label === "Paused — footage is in" && stNone.label === "In the edit (not confirmed) — footage is in" && stShot.label === "Ready for editing — footage is in",
    [stAct.label, stPau.label, stNone.label, stShot.label].join(" | "));
  const wn = await work.workingNow();
  const jd = wn.ok ? wn.editors.find((e) => e.key === "john") : null;
  const kd = wn.ok ? wn.editors.find((e) => e.key === "kim") : null;
  c.ok("Working now agrees: Kim on T1; John's X2 is a claim, not his active job", kd?.active?.projectId === T1.id && !!jd && jd.unconfirmed.some((u) => u.projectId === X2.id) && jd.active?.projectId !== X2.id,
    `kim: ${kd?.active?.street} · john: ${jd?.active?.street ?? "nothing"} (+${jd?.unconfirmed.length} claimed)`);
  c.ok("the workload lane is no longer called \"In editing\"", LANE_LABEL.editing !== "In editing" && laneOf("Paused") === "editing" && laneOf("In editing — not confirmed") === "editing", LANE_LABEL.editing);
  // A read that fails is a failure, not an empty board.
  await prisma.$executeRawUnsafe(`ALTER TABLE "EditorWorkItem" RENAME TO "EditorWorkItem_away"`);
  const failed = await work.workingNow();
  await prisma.$executeRawUnsafe(`ALTER TABLE "EditorWorkItem_away" RENAME TO "EditorWorkItem"`);
  c.ok("workingNow with the table unreadable returns ok:false with a reason — never \"nobody is working\"", !failed.ok && "error" in failed && /Couldn't read/.test(failed.error), failed.ok ? "ok:true" : failed.error);
  // workLabel over every lifecycle × {none, active, paused}.
  const P1 = { editorKey: "kim", name: "Kim", outputId: null, outputTitle: null, sinceISO: new Date().toISOString(), firstStartedISO: null, lastEventISO: new Date().toISOString(), lastEventKind: "START", onBehalfBy: null };
  const combos: [string, string, string][] = [];
  for (const lc of ["SHOT", "EDITING", "REVIEW", "REVISION", "APPROVED", "DELIVERED"]) {
    for (const [name, w] of [["none", undefined], ["active", { active: [P1], paused: [] }], ["paused", { active: [], paused: [P1] }]] as const) {
      const r = work.workLabel(lc, w as never, { baseLabel: lc });
      combos.push([lc, name, `${r.label}${r.chip ? ` [${r.chip}]` : ""}`]);
    }
  }
  const labelFor = (lc: string, n: string) => combos.find((x) => x[0] === lc && x[1] === n)?.[2] ?? "";
  c.ok("workLabel: SHOT → Ready for editing / In editing / Paused; EDITING alone → not confirmed",
    labelFor("SHOT", "none") === "Ready for editing" && labelFor("SHOT", "active").startsWith("In editing [Kim") && labelFor("SHOT", "paused").startsWith("Paused [Paused — Kim") && labelFor("EDITING", "none") === "In editing — not confirmed");
  c.ok("workLabel: review/revision stages keep their word and wear the chip",
    labelFor("REVISION", "active").startsWith("REVISION [Active — Kim") && labelFor("REVIEW", "paused").startsWith("REVIEW [Paused — Kim") && labelFor("REVIEW", "none") === "REVIEW");
  c.ok("workLabel: \"In editing\" never without an active person", combos.every(([, n, l]) => !l.startsWith("In editing [") || n === "active") && combos.every(([, n, l]) => !(l === "In editing") || n === "active"));

  // =========================================================================
  c.head("§R · review fixes (Sep 25): the pin, the hold, one video's hand-in, office moves, held cuts");
  // =========================================================================
  const settings = await import("@/lib/settings");
  const bells = () => prisma.notification.count({ where: { kind: "edit_started" } });
  {
    // #2 Start must not set the human-reassign flag (it took started jobs out
    // of Aryeo's cancel-when-removed and every unpinned-only closer); the
    // hourly re-route leaves started work with its editor anyway.
    await settings.putSetting("editor_routing", { standardVideo: "john", premiumVideo: "john", personalBranding: null }, null);
    const U1 = await mkJob({ street: "31 Unpinned Way", status: "SHOT", editor: "kim" });
    const U2 = await mkJob({ street: "32 Unpinned Way", status: "SHOT", editor: "kim" });
    await prisma.smartTask.updateMany({ where: { id: { in: [U1.cardId!, U2.cardId!] } }, data: { assignedManually: false } });
    await as(kim);
    const sU = await work.startEditing({ projectId: U1.id, requestId: "kim-U1" });
    const cU = await prisma.smartTask.findUniqueOrThrow({ where: { id: U1.cardId! } });
    c.ok("#2 Start moves the card to IN_PROGRESS and leaves assignedManually false (not a human pick)", sU.ok && cU.status === "IN_PROGRESS" && cU.assignedManually === false, `${cU.status} manual=${cU.assignedManually}`);
    await tasks.mintEditTask(U1.id);
    await tasks.mintEditTask(U2.id);
    const aU1 = (await prisma.smartTask.findUniqueOrThrow({ where: { id: U1.cardId! } })).assignedKey;
    const aU2 = (await prisma.smartTask.findUniqueOrThrow({ where: { id: U2.cardId! } })).assignedKey;
    c.ok("#2 the hourly re-route keeps started work with Kim (rules now say John)", aU1 === "kim", aU1 ?? "none");
    c.ok("#2 …and still re-routes an unpinned card nobody started (control)", aU2 === "john", aU2 ?? "none");
    // Aryeo's retire path cancels `edit-video-<id>` WHERE assignedManually=false
    // (integrations/aryeo.ts, the video dropped from the order). Same filter:
    const retired = await prisma.smartTask.updateMany({ where: { dedupeKey: `edit-video-${U1.id}`, assignedManually: false }, data: { status: "CANCELLED" } });
    c.ok("#2 the removed-video cancel now reaches a started card", retired.count === 1);
    await work.closeGhostWork(U1.id);
    c.ok("#2 …and the started work closes with it (no 'In editing' on a job that owes no video)", (await item("kim", U1.id))?.state === "CLOSED");
    await settings.putSetting("editor_routing", settings.DEFAULT_ROUTING, null);
  }
  {
    // #7 the office's start on a job it holds in Waiting: a start that fails
    // must leave the hold where it was.
    const { stampWaitingHold, loadWaitingHolds } = await import("@/lib/queueWaiting");
    const Wt = await mkJob({ street: "33 Waiting Hold Rd", status: "BOOKED", editor: "kim" });
    await stampWaitingHold(Wt.id, "Kyle");
    await prisma.$executeRawUnsafe(`INSERT INTO drill_fail VALUES ('${Wt.id}')`);
    await as(jordan);
    const failed = await work.startEditing({ projectId: Wt.id, forEditorKey: "kim", requestId: "office-Wt-1" });
    await prisma.$executeRawUnsafe(`DELETE FROM drill_fail`);
    const heldAfterFail = (await loadWaitingHolds([Wt.id])).has(Wt.id);
    c.ok("#7 an office start that fails says nothing changed — and the Waiting hold is still there", !failed.ok && /nothing changed/.test(failed.message) && heldAfterFail && (await status(Wt.id)) === "BOOKED", failed.message);
    const retry = await work.startEditing({ projectId: Wt.id, forEditorKey: "kim", requestId: "office-Wt-2" });
    c.ok("#7 …the retry starts it and releases the hold in the same step", retry.ok && !(await loadWaitingHolds([Wt.id])).has(Wt.id) && (await status(Wt.id)) === "EDITING", retry.message);
  }
  {
    // #15 handing in ONE video ends the stretch on THAT video only, and the
    // next video's Start is not a fresh office bell.
    const M2 = await mkJob({ street: "34 Four Videos Ln", status: "SHOT", editor: "kim", videos: 4 });
    await ensureOutputsForProject(M2.id);
    const outs = await prisma.deliverableOutput.findMany({ where: { projectId: M2.id }, orderBy: [{ slot: "asc" }], select: { id: true, slot: true } });
    const finalize = async (slot: number, outputId: string | null) => {
      const r = await prisma.reviewSubmission.create({
        data: { projectId: M2.id, kind: "video", deliverableId: M2.deliverableId, slot, outputId, round: 1, status: "UPLOADING", source: "upload", fileName: `four-v${slot}.mp4`, submittedByKey: "kim", submittedByName: "Kim Miguel" },
        select: { id: true },
      });
      return reviewCuts.finalizeCutUpload(r.id, {
        url: `https://drillstore.public.blob.vercel-storage.com/review-cuts/${M2.id}/${r.id}/four-v${slot}.mp4`,
        pathname: `review-cuts/${M2.id}/${r.id}/four-v${slot}.mp4`,
        size: 1000 + slot,
      });
    };
    await as(kim);
    const b0 = await bells();
    await work.startEditing({ projectId: M2.id, outputId: outs[2]?.id ?? null, requestId: "kim-M2-v3" });
    c.ok("#15 setup: 4 outputs, Kim active on video 3, one bell", outs.length === 4 && (await item("kim", M2.id))?.state === "ACTIVE" && (await bells()) === b0 + 1, `${outs.length} outputs`);
    await finalize(1, outs[0]?.id ?? null);
    const stillOn = await item("kim", M2.id);
    c.ok("#15 a fix to video 1 does NOT end her stretch on video 3", stillOn?.state === "ACTIVE" && stillOn.outputId === outs[2]?.id, `${stillOn?.state} ${stillOn?.closeReason ?? ""}`);
    await finalize(3, outs[2]?.id ?? null);
    const done3 = await item("kim", M2.id);
    c.ok("#15 handing in video 3 closes it (SUBMITTED)", done3?.state === "CLOSED" && done3.closeReason === "SUBMITTED");
    const b1 = await bells();
    const again = await work.startEditing({ projectId: M2.id, outputId: outs[3]?.id ?? null, requestId: "kim-M2-v4" });
    c.ok("#15 the next video's Start is logged (START) but rings no second office bell", again.ok && (await bells()) === b1 && (await events({ projectId: M2.id, kind: "START" })) === 2, again.message);
  }
  {
    // #17 the one-time "which one are you on?" is for history — an office pin
    // or a board move made since the Start button is the office's word.
    await as(jordan);
    const Zp = await mkJob({ street: "35 Office Pin Pl", status: "SHOT", editor: "john" });
    const Zm = await mkJob({ street: "36 Board Move Blvd", status: "SHOT", editor: "john" });
    await editing.saveEditOverrides(Zp.id, { status: "In editing" } as never);
    await appActions.moveProjectStatus(Zm.id, "EDITING");
    const jDesk = await work.myDesk("john");
    c.ok("#17 an office pin and a board move since the button are NOT re-asked as history",
      (await status(Zp.id)) === "EDITING" && (await status(Zm.id)) === "EDITING" && !jDesk.unconfirmed.some((u) => u.projectId === Zp.id || u.projectId === Zm.id),
      jDesk.unconfirmed.map((u) => u.street).join(", "));
    const rZ = await rowOf(Zp.id);
    c.ok("#17 …the pinned row still says what it is: In editing — not confirmed", rZ?.status === "In editing — not confirmed", rZ?.status);
  }
  {
    // #3 a cut HELD for the editor's check is the editor's move, not a verdict's.
    const H = await mkJob({ street: "37 Held Cut Ct", status: "SHOT", editor: "kim" });
    const hs = await prisma.reviewSubmission.create({
      data: { projectId: H.id, kind: "video", deliverableId: H.deliverableId, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "held.mp4", submittedByKey: "kim" },
      select: { id: true },
    });
    const oldQueue = (await import(baseline("src/lib/editorQueue.ts"))) as typeof import("@/lib/editorQueue");
    const oldRows = await oldQueue.buildEditorQueue();
    const { holdForSelfCheck } = await import("@/lib/selfCheckStore");
    await holdForSelfCheck(hs.id, "drill: waiting on the editor's check");
    const rH = await rowOf(H.id);
    c.ok(`#3 old (${BASE}): a PENDING cut read "Ready for review"`, [...oldRows.notDone, ...oldRows.upcoming, ...oldRows.done].find((r) => r.id === H.id)?.status === "Ready for review");
    c.ok("#3 held for the check: the row reads \"Check needed\" (the editor's lane), not Ready for review", rH?.status === "Check needed" && laneOf(rH.status) === "editing", rH?.status);
  }
  {
    // #14 the owner's dial says work owed and work happening apart.
    const { getOwnerDials } = await import("@/lib/queries");
    const dials = await getOwnerDials();
    const activeIds = [...new Set((await prisma.editorWorkItem.findMany({ where: { state: "ACTIVE" }, select: { projectId: true } })).map((x) => x.projectId))];
    const liveActive = await prisma.project.count({ where: { id: { in: activeIds }, status: { notIn: ["DELIVERED", "CANCELLED"] } } });
    const editingStage = await prisma.project.count({ where: { status: "EDITING" } });
    c.ok("#14 the dial's 'being edited now' is the Working-now count, not the EDITING stage", dials.video.editingNow === liveActive && liveActive !== editingStage, `now ${dials.video.editingNow} · active ${liveActive} · EDITING stage ${editingStage}`);
  }

  // ---- close ---------------------------------------------------------------
  c.ok("nothing left the building: every non-loopback call was blocked, none answered", fence.faked.length === 0, `${fence.blocked.length} blocked attempt(s)`);
  quiet.restore();
  c.summary();
  fs.rmSync(BASE_DIR, { recursive: true, force: true });
  await stop();
  fence.restore();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(BASE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(1);
});
