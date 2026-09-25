/**
 * FIVE BUSINESS JOURNEYS, DRIVEN THROUGH THE VIEWS — and then swept (Sep 20).
 *
 *   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && set -a && source .env; set +a \
 *     && NODE_OPTIONS=--conditions=react-server npx tsx \
 *        --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/journey-views.ts
 *
 * Production Neon is never touched — DATABASE_URL is overwritten below, before
 * any app module loads, with an in-process PGlite Postgres.
 *
 * WHAT IT HAS TO SHOW, in the order a day happens:
 *   1. Twenty exceptions of one kind: an honest total, a visible page, and the
 *      other sixteen actually reachable on the surface the card points at.
 *   2. An editor is repointed and a second version is handed in: the finished
 *      work stays credited to whoever did it, capacity is not inflated, and a
 *      revision is not a new deliverable.
 *   3. A video pulled off the order stops being a staffing exception.
 *   4. A driver that polls a dead render does not make it look alive.
 *   5. One mixed-media job — photos out, reel in revision, floor plan at a
 *      vendor — read by every surface that displays it, and they must agree.
 *      This is where it first broke: every surface agreed about WHAT was owed
 *      and not about WHEN it was promised, because projectBrief kept its own
 *      promise arithmetic off the job-level video SLA while the card an inch
 *      below it and Kyle's whole board called outstandingPromise. Fixed Sep 20
 *      2026; journey 5 now guards it at nine job ages and on the label as well
 *      as the minute — and, since that fix, on the three branches that had
 *      only ever been checked by reading production (a hand-set date, a
 *      delivered job's frozen promise, a reopened job with no clock) and on
 *      the OTHER card's select, which was the half of the page still reading
 *      the promise differently on 14 live jobs.
 *
 * METHOD, everywhere: build the fixture, run the SHIPPED action, then run the
 * BACKGROUND SWEEP, then assert. The sweeps run here are the real ones —
 * reconcileDeliverablesToOrder (the hourly Aryeo sync), sweepOutputUnits (the
 * hourly per-video repair), refreshOutputsForProject/linkRoundsToOutputs and
 * claimTopazJobs (the render driver's claim).
 *
 * PGlite's socket server multiplexes every client onto ONE database connection,
 * so nothing here claims to have proved isolation or true concurrency. Every
 * assertion below is about what one sequence of calls leaves behind.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { readFileSync } from "node:fs";
import { promisify } from "util";
import Module from "node:module";

const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f };
  if (request === "next/navigation") return { redirect: () => { throw new Error("redirect"); }, notFound: () => { throw new Error("notFound"); } };
  if (request === "next/headers") return {};
  // The dashboard card is a plain function component; it is CALLED below and
  // its element tree read for text, so Link only has to exist.
  if (request === "next/link") return { __esModule: true, default: (p: unknown) => p };
  // lucide-react builds its icons on React.createContext, which the react-server
  // build of React does not carry. The card's icons are decoration; only its
  // words are read below.
  if (request === "lucide-react") {
    return new Proxy({ __esModule: true }, { get: () => () => null });
  }
  return realLoad.call(this, request, parent, isMain);
};

const exec = promisify(execFile);
const PORT = 5503;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
delete process.env.AUTH_ENFORCE;

let pass = 0, fail = 0;
const failures: string[] = [];
const ok = (label: string, good: boolean, detail = "") => {
  if (good) pass++; else fail++;
  if (!good) failures.push(label);
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const head = (n: number, title: string) => {
  console.log(`\n${n}. ${title.toUpperCase()}`);
};

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

/** The text a React element tree would render, without react-dom (which refuses
 *  to load under the react-server condition this drill needs). Children only —
 *  no component is invoked, so what comes back is exactly the copy the card
 *  itself writes. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function textOf(node: any): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && node.props) return textOf(node.props.children);
  return "";
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const { opsExceptionsBoard, EXCEPTION_RULES } = await import("@/lib/opsExceptions");
  const { ExceptionsCard } = await import("@/components/ops/ExceptionsCard");
  const { buildEditorQueue } = await import("@/lib/editorQueue");
  const { editingWorkload, measuredThroughput } = await import("@/lib/editorWorkload");
  const { setEditVideoEditor, setQueueStatus } = await import("@/app/editing/actions");
  const { reconcileDeliverablesToOrder, orderDeliverables } = await import("@/lib/integrations/aryeo");
  const { sweepOutputUnits, ensureOutputsForProject, refreshOutputsForProject, linkRoundsToOutputs, outputsForProject } =
    await import("@/lib/deliverableOutputs");
  const { claimTopazJobs } = await import("@/lib/topazJobs");
  const { projectBrief } = await import("@/lib/projectBrief");
  const { deliveryBoard } = await import("@/lib/deliveryBoard");
  const { computeStatus, videoUnitTally, expectedCategories } = await import("@/lib/projectStatus");
  const { owedNow, parseEvidence } = await import("@/lib/statusEvidence");

  type Order = Parameters<typeof reconcileDeliverablesToOrder>[1];
  const REEL = "Standard Video Highlight Reel";
  const PHOTOS = "Professional Photography";
  const FLOORPLAN = "2D Floorplan";
  const order = (number: number, ...items: ({ title: string; quantity?: number } | string)[]): Order =>
    ({
      id: `ord-${number}`,
      number,
      items: items.map((it, i) => {
        const o = typeof it === "string" ? { title: it, quantity: 1 } : it;
        return { id: `it-${number}-${i}`, title: o.title, quantity: o.quantity ?? 1, amount: 25000 };
      }),
    }) as Order;

  console.log("=".repeat(76));
  console.log("Five journeys through the views, each swept after the transition");
  console.log("=".repeat(76));

  // ---------------------------------------------------------------------
  head(0, "the fixtures parse — nothing below proves anything if they do not");
  const reelTypes = orderDeliverables(order(1, REEL).items).map((d) => d.type);
  const photoTypes = orderDeliverables(order(1, PHOTOS).items).map((d) => d.type);
  const planTypes = orderDeliverables(order(1, FLOORPLAN).items).map((d) => d.type);
  ok(`"${REEL}" implies a video row`, reelTypes.includes("SOCIAL_REEL") || reelTypes.includes("VIDEO"), reelTypes.join("+") || "(nothing)");
  ok(`"${PHOTOS}" implies photos and no video`, photoTypes.includes("PHOTOS") && !photoTypes.some((t) => t === "VIDEO" || t === "SOCIAL_REEL"), photoTypes.join("+"));
  ok(`"${FLOORPLAN}" implies a floor plan`, planTypes.includes("FLOORPLAN"), planTypes.join("+"));
  ok("the board's per-kind cap is four, which is what the card claims to page at", EXCEPTION_RULES.perKind === 4, String(EXCEPTION_RULES.perKind));

  const client = await prisma.client.create({ data: { name: "Mike Flatley" }, select: { id: true } });
  const shooter = await prisma.teamMember.create({
    data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER", payPercent: 0.35, payFloor: 100 },
    select: { id: true },
  });
  const kim = await prisma.teamMember.create({
    data: { name: "Kim Miguel", email: "kim@drill.invalid", role: "EDITOR", payPercent: 0.3, payFloor: 50 },
    select: { id: true },
  });
  const john = await prisma.teamMember.create({
    data: { name: "John Mark", email: "john@drill.invalid", role: "EDITOR", payPercent: 0.3, payFloor: 50 },
    select: { id: true },
  });

  let seq = 0;
  const mk = async (street: string, over: Record<string, unknown> = {}) =>
    prisma.project.create({
      data: {
        title: `${street}, Royersford, PA`,
        clientId: client.id,
        status: "EDITING",
        aryeoOrderId: `ord-${++seq}`,
        payableInvoice: 450,
        price: 450,
        shootDate: ago(4 * DAY),
        photographerId: shooter.id,
        ...over,
      },
      select: { id: true },
    });

  // =====================================================================
  head(1, "twenty exceptions of one kind — an honest total, and the rest reachable");
  // Twenty jobs land from the Aryeo import owing a reel with nobody on them.
  // Seven are already past the date the client was given.
  const twenty: string[] = [];
  for (let i = 0; i < 20; i++) {
    const late = i < 7;
    const p = await mk(`${100 + i} Exception Ave`, { shootDate: ago((10 + i) * DAY) });
    // The REAL import path mints the deliverable — not a hand-written row.
    await reconcileDeliverablesToOrder(p.id, order(2000 + i, REEL));
    // The promise is set AFTER the sync, because the sync writes deliveryDue
    // itself off the video SLA — setting it first and asserting on it would be
    // asserting on a value the code under test had already replaced.
    await prisma.project.update({
      where: { id: p.id },
      data: { deliveryDue: late ? ago((i + 1) * DAY) : ahead((i + 1) * DAY) },
    });
    twenty.push(p.id);
  }
  // THE SWEEP, before anybody looks at the card.
  const sweep1 = await sweepOutputUnits({ max: 200 });
  console.log(`   sweep: sweepOutputUnits checked ${sweep1.checked} jobs, created ${sweep1.created} per-video rows`);

  const board1 = await opsExceptionsBoard();
  const unassignedRows = board1.rows.filter((r) => r.kind === "unassigned");
  console.log(`   board: totals.unassigned = ${JSON.stringify(board1.totals.unassigned)}, rows of that kind = ${unassignedRows.length}`);
  ok("the board counts all twenty, not the page it is showing", board1.totals.unassigned.all === 20, `all=${board1.totals.unassigned.all}`);
  ok("…and knows seven of them are past their date", board1.totals.unassigned.high === 7, `high=${board1.totals.unassigned.high}`);
  ok("it shows four, the per-kind cap", unassignedRows.length === 4, String(unassignedRows.length));
  ok("every row it shows has a name on it and one thing to do", unassignedRows.every((r) => r.title && r.owner && r.nextAction), unassignedRows[0]?.nextAction ?? "");
  ok("the four it shows are the ones past their date", unassignedRows.every((r) => r.severity === "high"), unassignedRows.map((r) => r.severity).join(","));

  const cardText = textOf(ExceptionsCard({ rows: board1.rows, totals: board1.totals }));
  console.log(`   card: ${cardText.replace(/\s+/g, " ").slice(0, 190)}`);
  ok('the card says "20 things with a name on them"', /20 things with a name on them/.test(cardText), cardText.slice(0, 80));
  ok('…and says out loud that it is only showing 4', /showing 4/.test(cardText));
  ok('…and the group header says "showing 4 of 20"', /showing 4 of 20/.test(cardText));
  ok("…and the urgency count is the pile's, not the page's (7, not 4)", /7 worth doing today/.test(cardText));

  // REACHABLE. The card's own next action is "Pick an editor on the row in the
  // Editing Room", so that board is where the other sixteen have to be.
  const queue1 = await buildEditorQueue();
  const inQueue = new Set(queue1.notDone.map((r) => r.id));
  const reachable = twenty.filter((id) => inQueue.has(id));
  ok("all twenty are reachable on the Editing Room the card sends you to", reachable.length === 20, `${reachable.length} of 20`);
  const twentyRows = queue1.notDone.filter((r) => twenty.includes(r.id));
  ok("none of the twenty has an editor on the job itself", (await prisma.project.count({ where: { id: { in: twenty }, editorId: null, editorVendorKey: null } })) === 20);
  ok("…and the Editing Room marks every one of them as a routing GUESS, not an assignment", twentyRows.every((r) => r.auto === true), `auto=${[...new Set(twentyRows.map((r) => r.auto))].join(",")} names=${[...new Set(twentyRows.map((r) => r.editor))].join("/")}`);

  // =====================================================================
  head(2, "an editor is repointed and a second version is handed in");
  const P2 = await mk("12 Rework Rd", { editorId: kim.id, deliveryDue: ahead(2 * DAY), shootDate: ago(20 * DAY) });
  await reconcileDeliverablesToOrder(P2.id, order(2100, { title: REEL, quantity: 2 }));
  const reel2 = await prisma.deliverable.findFirstOrThrow({
    where: { projectId: P2.id, type: { in: ["VIDEO", "SOCIAL_REEL"] } },
    select: { id: true, quantity: true },
  });
  if (reel2.quantity !== 2) await prisma.deliverable.update({ where: { id: reel2.id }, data: { quantity: 2 } });
  await ensureOutputsForProject(P2.id);
  const outsBefore = await prisma.deliverableOutput.count({ where: { projectId: P2.id, removedFromOrderAt: null } });
  ok("a two-video reel row owes two per-video rows", outsBefore === 2, String(outsBefore));

  // Kim's finished work, over the throughput window. THREE approvals, which is
  // the floor below which the panel refuses to state a rate at all. Video 1 of
  // this job is one of them; video 2 was never started.
  const approved = async (projectId: string, deliverableId: string, slot: number, decided: Date) =>
    prisma.reviewSubmission.create({
      data: {
        projectId, deliverableId, slot, round: 1, kind: "video", source: "upload",
        status: "APPROVED", decidedAt: decided, submittedByKey: "kim", submittedByName: "Kim",
        fileName: `slot${slot}-v1.mp4`,
      },
      select: { id: true },
    });
  await approved(P2.id, reel2.id, 1, ago(14 * DAY));
  const others: string[] = [];
  for (const [i, street] of ["14 Rework Rd", "16 Rework Rd"].entries()) {
    const p = await mk(street, { editorId: kim.id });
    await reconcileDeliverablesToOrder(p.id, order(2101 + i, REEL));
    const d = await prisma.deliverable.findFirstOrThrow({ where: { projectId: p.id, type: { in: ["VIDEO", "SOCIAL_REEL"] } }, select: { id: true } });
    await approved(p.id, d.id, 1, ago((3 + i) * DAY));
    others.push(p.id);
  }

  const creditBefore = await measuredThroughput();
  console.log(`   before the reassignment: ${JSON.stringify([...creditBefore])}`);
  ok("Kim is credited with the three cuts she handed in", creditBefore.get("kim") === 3, String(creditBefore.get("kim")));

  // THE REAL ACTION — the queue's own reassign.
  const moved = await setEditVideoEditor(P2.id, "john");
  ok("the reassignment is accepted", moved.ok, moved.message);

  // THE SWEEPS, after the transition.
  const sweep2 = await sweepOutputUnits({ max: 200 });
  await refreshOutputsForProject(P2.id);
  const linked = await linkRoundsToOutputs(P2.id);
  console.log(`   sweep: sweepOutputUnits created ${sweep2.created}, linked ${sweep2.linkedRounds} rounds; refresh linked ${linked} more`);

  const creditAfter = await measuredThroughput();
  console.log(`   after the reassignment + sweep: ${JSON.stringify([...creditAfter])}`);
  ok("the finished cut is STILL credited to Kim, who handed it in", creditAfter.get("kim") === 3, String(creditAfter.get("kim")));
  ok("…and John is credited with none of it", (creditAfter.get("john") ?? 0) === 0, String(creditAfter.get("john") ?? 0));

  const rowsFor = (q: Awaited<ReturnType<typeof buildEditorQueue>>, ids: string[]) =>
    [...q.notDone, ...q.upcoming].filter((r) => ids.includes(r.id)).map((r) => ({
      status: r.status, editorKey: r.editorKey, editor: r.editor, videos: r.videos, dueISO: r.dueISO, late: r.late,
    }));
  const queue2 = await buildEditorQueue();
  const row2 = [...queue2.notDone, ...queue2.done].find((r) => r.id === P2.id);
  ok("the job is on the board, and on John now", !!row2 && row2.editorKey === "john", row2?.editorKey ?? "(no row)");
  // "to edit", not "in editing" since Sep 25 (§7.1, A64): a video nobody has
  // handed in is owed, and nothing says anyone is cutting it.
  ok("the job owes two videos, one of them already finished", row2?.videos === 2 && row2?.videoBreakdown === "1 approved · 1 more to edit", `videos=${row2?.videos} "${row2?.videoBreakdown}"`);
  const load2 = await editingWorkload(rowsFor(queue2, [P2.id, ...others]));
  const john2 = load2.editors.find((e) => e.key === "john");
  const kim2 = load2.editors.find((e) => e.key === "kim");
  console.log(`   workload after the reassign: john active=${john2?.activeVideos} jobs=${john2?.activeJobs} lanes=${JSON.stringify(john2?.lanes)}`);
  ok("John's desk carries the job once, not twice", john2?.activeJobs === 1, String(john2?.activeJobs));
  ok("…and its videos once, not doubled", john2?.activeVideos === 2, String(john2?.activeVideos));
  ok("Kim keeps the rate her own finished work earned", kim2?.sampleCuts === 3 && kim2?.perWeek !== null, `sample=${kim2?.sampleCuts} perWeek=${String(kim2?.perWeek)}`);
  ok("John gets no rate off somebody else's cuts", (john2?.sampleCuts ?? 0) === 0 && john2?.perWeek === null, `sample=${john2?.sampleCuts} perWeek=${String(john2?.perWeek)}`);

  // A SECOND VERSION. The client came back on the video that was already
  // approved, so the Review Room holds a newer round that was sent back.
  await prisma.reviewSubmission.create({
    data: {
      projectId: P2.id, deliverableId: reel2.id, slot: 1, round: 2, kind: "video", source: "upload",
      status: "CHANGES_REQUESTED", decidedAt: ago(2 * HOUR), decidedBy: "Jordan",
      submittedByKey: "john", submittedByName: "John Mark", fileName: "slot1-v2.mp4",
    },
  });
  const sweep2b = await sweepOutputUnits({ max: 200 });
  await refreshOutputsForProject(P2.id);
  console.log(`   sweep after the new version: created ${sweep2b.created}, linked ${sweep2b.linkedRounds} rounds`);

  const queue2b = await buildEditorQueue();
  const row2b = [...queue2b.notDone, ...queue2b.done].find((r) => r.id === P2.id);
  const outsAfter = await prisma.deliverableOutput.count({ where: { projectId: P2.id, removedFromOrderAt: null, waivedAt: null } });
  ok("a new version is not a new deliverable — still two per-video rows", outsAfter === 2, String(outsAfter));
  ok("…and the Editing Room still says two videos, not three", row2b?.videos === 2, String(row2b?.videos));
  ok("…and the row now says one is back with the editor", row2b?.status === "Revisions", `${row2b?.status} "${row2b?.videoBreakdown}"`);
  const load2b = await editingWorkload(rowsFor(queue2b, [P2.id, ...others]));
  const john2b = load2b.editors.find((e) => e.key === "john");
  console.log(`   workload after the new version: john active=${john2b?.activeVideos} jobs=${john2b?.activeJobs}`);
  ok("the second version did not grow John's capacity", john2b?.activeVideos === 2 && john2b?.activeJobs === 1, `${john2b?.activeVideos} videos / ${john2b?.activeJobs} jobs`);
  const creditFinal = await measuredThroughput();
  ok("and the credit for the FIRST version has not moved", creditFinal.get("kim") === 3 && (creditFinal.get("john") ?? 0) === 0, JSON.stringify([...creditFinal]));

  // =====================================================================
  head(3, "a video pulled off the order stops being a staffing exception");
  const beforePull = (await opsExceptionsBoard()).totals.unassigned;
  const P3 = await mk("632 Greenridge Rd", { deliveryDue: ago(6 * DAY), shootDate: ago(12 * DAY) });
  await reconcileDeliverablesToOrder(P3.id, order(2200, PHOTOS, REEL));
  await ensureOutputsForProject(P3.id);
  const outs3 = await prisma.deliverableOutput.count({ where: { projectId: P3.id, removedFromOrderAt: null } });
  ok("the job owes a per-video row while the line is on the order", outs3 === 1, String(outs3));
  const withVideo = (await opsExceptionsBoard()).totals.unassigned;
  ok("while the video is on the order it IS an exception", withVideo.all === beforePull.all + 1, `${beforePull.all} → ${withVideo.all}`);
  ok("…and it is on the Editing Room", (await buildEditorQueue()).notDone.some((r) => r.id === P3.id));

  // THE REAL ACTION — the line comes off the Aryeo order, and the hourly sync
  // is what notices.
  const pulled = await reconcileDeliverablesToOrder(P3.id, order(2200, PHOTOS));
  ok("the sync retires the video row", pulled.retired.length === 1, JSON.stringify(pulled.retired));
  const sweep3 = await sweepOutputUnits({ max: 200 });
  console.log(`   sweep: sweepOutputUnits retired ${sweep3.retired} per-video rows`);
  const afterPull = (await opsExceptionsBoard()).totals.unassigned;
  ok("a retired video is not a job nobody has staffed", afterPull.all === beforePull.all, `${withVideo.all} → ${afterPull.all}`);
  ok("…and the job leaves the Editing Room with it", !(await buildEditorQueue()).notDone.some((r) => r.id === P3.id));
  const kept = await prisma.deliverableOutput.findMany({ where: { projectId: P3.id }, select: { removedFromOrderAt: true } });
  ok("…and the per-video row is RETIRED, not deleted", kept.length === 1 && !!kept[0].removedFromOrderAt, `${kept.length} row(s), removedAt=${kept[0]?.removedFromOrderAt?.toISOString() ?? "null"}`);

  // The office's own "not required on this job" is the other way a video stops
  // being owed, and the same rule has to cover it.
  const P3b = await mk("195 Woodhill Rd", { deliveryDue: ago(2 * DAY) });
  await reconcileDeliverablesToOrder(P3b.id, order(2201, REEL));
  const waivedBase = (await opsExceptionsBoard()).totals.unassigned.all;
  await prisma.deliverable.updateMany({
    where: { projectId: P3b.id, type: { in: ["VIDEO", "SOCIAL_REEL"] } },
    data: { waivedAt: new Date(), waivedBy: "kyle", waivedNote: "Discounted off the package" },
  });
  await sweepOutputUnits({ max: 200 });
  const waivedAfter = (await opsExceptionsBoard()).totals.unassigned.all;
  ok("a WAIVED video is not a staffing exception either", waivedAfter === waivedBase - 1, `${waivedBase} → ${waivedAfter}`);

  // =====================================================================
  head(4, "polling a dead render does not make it look alive");
  const P4 = await mk("322 N 62nd St", { editorId: john.id, deliveryDue: ahead(DAY) });
  await reconcileDeliverablesToOrder(P4.id, order(2300, REEL));
  const reel4 = await prisma.deliverable.findFirstOrThrow({ where: { projectId: P4.id, type: { in: ["VIDEO", "SOCIAL_REEL"] } }, select: { id: true } });
  const cut4 = await prisma.reviewSubmission.create({
    data: { projectId: P4.id, deliverableId: reel4.id, slot: 1, round: 1, kind: "video", source: "upload", status: "PENDING", fileName: "cut-v1.mp4" },
    select: { id: true },
  });
  const stalled = await prisma.topazJob.create({
    data: {
      submissionId: cut4.id, projectId: P4.id, state: "processing",
      createdAt: ago(10 * HOUR), startedAt: ago(10 * HOUR), acceptedAt: ago(10 * HOUR),
    },
    select: { id: true, updatedAt: true },
  });
  const renderRow = async () => (await opsExceptionsBoard()).rows.find((r) => r.id === `render:${stalled.id}`);
  const before4 = await renderRow();
  ok("a render that has not moved in ten hours is on the board", !!before4, before4?.why ?? "(absent)");
  ok("…and it says how long, from the driver's own clock", /10h/.test(before4?.why ?? ""), before4?.why ?? "");

  // THE REAL POLL — the driver's claim, which is what touches the row hourly.
  const claimed = await claimTopazJobs(5, "drill-tick");
  const afterClaim = await prisma.topazJob.findUniqueOrThrow({ where: { id: stalled.id }, select: { updatedAt: true, leaseBy: true } });
  console.log(`   poll: claimed ${claimed.length} row(s); updatedAt moved ${stalled.updatedAt.toISOString()} → ${afterClaim.updatedAt.toISOString()}`);
  ok("the poll really did claim the row and move @updatedAt", claimed.includes(stalled.id) && afterClaim.updatedAt > stalled.updatedAt, afterClaim.leaseBy ?? "");
  const after4 = await renderRow();
  ok("the stalled render is STILL on the board after the poll", !!after4, after4?.why ?? "(gone — the poll hid it)");
  ok("…and it still says ten hours, not zero", /10h/.test(after4?.why ?? ""), after4?.why ?? "");
  ok("…and it still has an owner and a next action", !!after4 && after4.owner === "Kyle" && !!after4.nextAction, after4?.nextAction ?? "");

  // The two rows that must NOT be on it, so the test is not "everything fires".
  const P4b = await mk("18 Held Ln", { editorId: john.id });
  await reconcileDeliverablesToOrder(P4b.id, order(2301, REEL));
  const reel4b = await prisma.deliverable.findFirstOrThrow({ where: { projectId: P4b.id, type: { in: ["VIDEO", "SOCIAL_REEL"] } }, select: { id: true } });
  const cut4b = await prisma.reviewSubmission.create({
    data: { projectId: P4b.id, deliverableId: reel4b.id, slot: 1, round: 1, kind: "video", source: "upload", status: "PENDING", fileName: "held-v1.mp4" },
    select: { id: true },
  });
  const held = await prisma.topazJob.create({
    data: {
      submissionId: cut4b.id, projectId: P4b.id, state: "queued",
      createdAt: ago(12 * HOUR), nextAttemptAt: ahead(4 * HOUR),
    },
    select: { id: true },
  });
  const P4c = await mk("9 Moving St", { editorId: john.id });
  await reconcileDeliverablesToOrder(P4c.id, order(2302, REEL));
  const reel4c = await prisma.deliverable.findFirstOrThrow({ where: { projectId: P4c.id, type: { in: ["VIDEO", "SOCIAL_REEL"] } }, select: { id: true } });
  const cut4c = await prisma.reviewSubmission.create({
    data: { projectId: P4c.id, deliverableId: reel4c.id, slot: 1, round: 1, kind: "video", source: "upload", status: "PENDING", fileName: "moving-v1.mp4" },
    select: { id: true },
  });
  const moving = await prisma.topazJob.create({
    data: {
      submissionId: cut4c.id, projectId: P4c.id, state: "saving",
      createdAt: ago(12 * HOUR), acceptedAt: ago(12 * HOUR), startedAt: ago(11 * HOUR), savingStartedAt: ago(20 * 60_000),
    },
    select: { id: true },
  });
  const board4 = await opsExceptionsBoard();
  ok("a render parked on purpose by the spend cap is NOT called stuck", !board4.rows.some((r) => r.id === `render:${held.id}`));
  ok("a render that actually moved twenty minutes ago is not stuck either", !board4.rows.some((r) => r.id === `render:${moving.id}`));
  ok("the stalled one is the only render on the board", board4.totals["stalled-render"].all === 1, JSON.stringify(board4.totals["stalled-render"]));

  // =====================================================================
  head(5, "one mixed-media job, read by every surface that displays it");
  // Photos delivered, a reel in revision, a floor plan still at the vendor.
  const M = await mk("893 S Matlack St", { editorId: john.id, deliveryDue: ago(DAY), shootDate: ago(5 * DAY), debriefSubmittedAt: ago(4 * DAY) });
  const mixedTitles = [PHOTOS, REEL, FLOORPLAN];
  const mixedOrder = order(2400, ...mixedTitles);
  await reconcileDeliverablesToOrder(M.id, mixedOrder);
  for (const title of mixedTitles) {
    await prisma.orderItem.create({ data: { projectId: M.id, title, quantity: 1, amount: 250 } });
  }
  const mixed = await prisma.deliverable.findMany({ where: { projectId: M.id }, select: { id: true, type: true, label: true } });
  console.log(`   ordered: ${mixed.map((d) => `${d.type}(${d.label ?? "-"})`).join(", ")}`);
  ok("the order produced all three lines", mixed.length === 3 && new Set(mixed.map((d) => d.type)).size === 3, mixed.map((d) => d.type).join("+"));
  const mReel = mixed.find((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL")!;
  const mPhotos = mixed.find((d) => d.type === "PHOTOS")!;
  const mPlan = mixed.find((d) => d.type === "FLOORPLAN")!;
  // The photos really went out; the floor plan has not come back from the vendor.
  await prisma.deliverable.update({ where: { id: mPhotos.id }, data: { status: "DONE", uploadedAt: ago(3 * DAY) } });
  await prisma.deliverable.update({ where: { id: mPlan.id }, data: { status: "PENDING", notes: "CubiCasa scan not back yet" } });
  await ensureOutputsForProject(M.id);

  // The editor hands in a cut, and the client asks for changes on it.
  const mCut = await prisma.reviewSubmission.create({
    data: {
      projectId: M.id, deliverableId: mReel.id, slot: 1, round: 1, kind: "video", source: "upload",
      status: "CHANGES_REQUESTED", decidedAt: ago(DAY), decidedBy: "Jordan",
      submittedByKey: "john", submittedByName: "John Mark", fileName: "matlack-v1.mp4",
    },
    select: { id: true },
  });
  await prisma.project.update({
    where: { id: M.id },
    data: { revisionNote: "Swap the opening shot and lose the drone push-in.", revisionRequestedAt: ago(DAY) },
  });
  // THE REAL ACTION — the queue pill puts the job into Revisions.
  const toRev = await setQueueStatus(M.id, "Revisions");
  ok("the queue pill moves the job into Revisions", toRev.ok, toRev.message);

  // The hourly status sweep's own verdict, from the SHIPPED engine, off signals
  // a real listing/Dropbox read would produce: 38 photos live on Aryeo, no
  // video up there, no floor plan, nothing finished in our Final folder.
  const writeEvidence = async () => {
    const dl = await prisma.deliverable.findMany({ where: { projectId: M.id, removedFromOrderAt: null }, select: { type: true, label: true, quantity: true } });
    const outs = await prisma.deliverableOutput.findMany({
      where: { projectId: M.id, removedFromOrderAt: null, waivedAt: null },
      select: { deliverableId: true, slot: true, category: true, deliveredAt: true, approvedAt: true },
    });
    const tally = videoUnitTally(dl, outs);
    const now = new Date();
    const res = computeStatus({
      expected: expectedCategories(dl),
      aryeo: { photos: 38, videos: 0, floorPlans: 0, interactive: 0, delivery: "UNDELIVERED", cover: null, at: now.toISOString() },
      dropbox: { rawPhotos: 210, rawVideo: 6, finalPhotos: 38, finalVideo: 0, at: now.toISOString() },
      fulfilled: false,
      officeConfirmed: false,
      units: tally ? [tally] : [],
      scheduled: false, anyAppt: true, datedAppt: true, postponed: false,
      shootDate: ago(5 * DAY), videoAnchor: ago(5 * DAY), shootPending: false,
      dropboxUnavailable: false,
      revisionOpen: true,
      videoTier: "standard", videoType: mReel.type, monthlyContent: false,
      read: { aryeo: "ok", dropbox: "ok", error: null },
    });
    await prisma.project.update({
      where: { id: M.id },
      data: {
        statusEvidence: JSON.stringify(res.evidence),
        statusCheckedAt: now, evidenceAttemptedAt: now, evidenceSucceededAt: now, evidenceError: null,
      },
    });
    return res;
  };
  const status1 = await writeEvidence();
  console.log(`   evidence: present=${JSON.stringify(status1.evidence.present)} missing=${JSON.stringify(status1.evidence.missing)} awaitingSend=${JSON.stringify(status1.evidence.awaitingSend)}`);

  // THE SWEEPS, after the transition: the per-video repair and the hourly
  // Aryeo reconcile against the job's own unchanged order.
  const sweep5 = await sweepOutputUnits({ max: 200 });
  const resync = await reconcileDeliverablesToOrder(M.id, mixedOrder);
  await writeEvidence();
  console.log(`   sweep: outputs created ${sweep5.created} / retired ${sweep5.retired}; aryeo resync ${JSON.stringify({ added: resync.added, retired: resync.retired, restored: resync.restored })}`);
  ok("the hourly resync changes nothing about a job whose order did not change", resync.added.length === 0 && resync.retired.length === 0 && resync.restored.length === 0, JSON.stringify(resync));
  ok("…and the job still owes all three lines", (await prisma.deliverable.count({ where: { projectId: M.id, removedFromOrderAt: null, waivedAt: null } })) === 3);

  // ---- NOW ASK EVERY SURFACE THE SAME QUESTION -------------------------
  const brief = await projectBrief(M.id);
  const dboard = await deliveryBoard();
  const bJob = [...dboard.today, ...dboard.tomorrow, ...dboard.upcoming, ...dboard.delivered].find((j) => j.id === M.id);
  const board5 = await opsExceptionsBoard();
  const queue5 = await buildEditorQueue();
  const qRow = [...queue5.notDone, ...queue5.upcoming, ...queue5.done].find((r) => r.id === M.id);
  const ev = parseEvidence((await prisma.project.findUniqueOrThrow({ where: { id: M.id }, select: { statusEvidence: true } })).statusEvidence);
  const owed = owedNow(ev);
  const outs5 = await outputsForProject(M.id);

  console.log(`   brief : owner=${brief?.owner.who} · next="${brief?.nextAction}" · tone=${brief?.tone.kind} · owed=${JSON.stringify(brief?.tone.missing)} · overdue=${brief?.overdue}`);
  console.log(`   board : column=${dboard.today.some((j) => j.id === M.id) ? "today" : dboard.upcoming.some((j) => j.id === M.id) ? "upcoming" : "elsewhere"} · blocker=${bJob?.blocker} "${bJob?.blockerLabel}" · dueFor=${bJob?.dueFor} · overdue=${bJob?.overdue}`);
  console.log(`   queue : status=${qRow?.status} · typeDetail="${qRow?.typeDetail}" · videos=${qRow?.videos} · editor=${qRow?.editor}`);
  console.log(`   owedNow: ${JSON.stringify(owed.categories)} · outputs: ${outs5.map((o) => `${o.label}:${o.state}`).join(", ")}`);

  ok("every surface answered at all", !!brief && !!bJob && !!qRow && !!ev, `brief=${!!brief} board=${!!bJob} queue=${!!qRow} evidence=${!!ev}`);

  // (a) THE PHOTOS ARE OUT — and nothing claims otherwise.
  ok("the status engine does not list Photos as owed", !owed.categories.some((c) => /photo/i.test(c)), JSON.stringify(owed.categories));
  ok("the brief does not list Photos as owed", !(brief?.tone.missing ?? []).some((c) => /photo/i.test(c)), JSON.stringify(brief?.tone.missing));
  ok("Kyle's board shows the photos live on the listing", (bJob?.media.photos.liveOnAryeo ?? 0) === 38, String(bJob?.media.photos.liveOnAryeo));
  ok("…and does not chase the photos as the thing that is due", !/photograph/i.test(bJob?.dueFor ?? ""), bJob?.dueFor ?? "(none)");
  ok("the brief still SHOWS the photos in scope — delivered is not deleted", (brief?.scope ?? []).some((s) => /photo/i.test(s)), JSON.stringify(brief?.scope));

  // (b) THE REEL IS IN REVISION — everywhere.
  ok("the per-video row says the reel is back with the editor", outs5.some((o) => o.state === "in_revisions"), outs5.map((o) => o.state).join(","));
  ok("the brief puts the next move on the editor who has it", brief?.owner.who === "John Mark" && brief?.owner.whose === "editor", `${brief?.owner.who}/${brief?.owner.whose}`);
  ok("…and asks for the next version, not a verdict and not a send", /next version/i.test(brief?.nextAction ?? ""), brief?.nextAction ?? "");
  ok("the Editing Room row reads Revisions", qRow?.status === "Revisions", qRow?.status ?? "");
  ok("Kyle's board calls the blocker a revision", bJob?.blocker === "revision", `${bJob?.blocker} / ${bJob?.blockerLabel}`);
  ok("the status engine still counts the video as owed", owed.categories.some((c) => /video/i.test(c)), JSON.stringify(owed.categories));

  // (c) THE FLOOR PLAN IS STILL AT THE VENDOR — everywhere it is displayed.
  ok("the status engine counts the floor plan as owed", owed.categories.some((c) => /floor/i.test(c)), JSON.stringify(owed.categories));
  ok("the brief says the floor plan is owed", (brief?.tone.missing ?? []).some((c) => /floor/i.test(c)), JSON.stringify(brief?.tone.missing));
  ok("the brief keeps the floor plan in scope", (brief?.scope ?? []).some((s) => /floor/i.test(s)), JSON.stringify(brief?.scope));
  ok("Kyle's board lists the floor plan among what was ordered", (bJob?.items ?? []).some((i) => /floor/i.test(i.title)), JSON.stringify(bJob?.items.map((i) => i.title)));
  ok("the Editing Room narrates the VIDEO lane only, and names the reel", !!qRow && /reel|video/i.test(qRow.typeDetail) && !/floor|photograph/i.test(qRow.typeDetail), qRow?.typeDetail ?? "");
  ok("…and does not book the photos or the floor plan as the editor's videos", qRow?.videos === 1, String(qRow?.videos));

  // (d) LATE IS LATE — on every screen at once.
  ok("the brief calls the job overdue", brief?.overdue === true, String(brief?.overdue));
  ok("Kyle's board calls the same job overdue", bJob?.overdue === true, String(bJob?.overdue));
  ok("the Editing Room row is late too", qRow?.late === true, `late=${qRow?.late} due=${qRow?.dueISO}`);
  ok("…and all three are keyed on the same promise", !!brief?.promisedAt && !!bJob?.dueAt && brief.promisedAt.getTime() === bJob.dueAt.getTime(), `brief=${brief?.promisedAt?.toISOString()} for "${brief?.tone.promiseFor}" · board=${bJob?.dueAt?.toISOString()} for "${bJob?.dueFor}"`);
  // …and on the same SUBJECT. The date alone was only half of it: the brief
  // used to label every promise "Video" (or, after the photo-only fix, "Video"
  // or "Photos"), so on a mixed job the page named the video while the card an
  // inch below it and Kyle's board both named the floor plan (F05, review Sep
  // 20 2026 — 25 live jobs).
  ok("…and on the same THING, not just the same minute", !!brief?.tone.promiseFor && brief.tone.promiseFor === bJob?.dueFor, `brief="${brief?.tone.promiseFor}" · board="${bJob?.dueFor}"`);
  ok("the status tone is not 'everything is confirmed'", brief?.tone.kind !== "clear", brief?.tone.kind ?? "");

  // ---- DOES THAT DISAGREEMENT EVER CHANGE THE VERDICT? -------------------
  // The board dates a job by its EARLIEST OUTSTANDING item (outstandingPromise,
  // deliveryBoard.ts:269). The brief used to date it by Project.deliveryDue,
  // which the Aryeo sync writes off the VIDEO SLA — so on a mixed job, where
  // the floor plan's promise falls first, there was a window in which one
  // screen called the job late and the other called it on time. This walked a
  // fresh job through that window hour by hour: all nine differed, by 10 to 28
  // hours, and at 42h the board said LATE while the project page said on time.
  //
  // FIXED Sep 20 2026: projectBrief now calls outstandingPromise itself and
  // takes both the date and the label from it, so the loop below is a
  // regression guard rather than a measurement. It is kept at nine spacings
  // because that is what caught it — a single fixture at one age would have
  // passed on the hours where the two engines happened to coincide.
  // `same` is carried separately from `gapH`, and gapH is NULL rather than 0
  // when either side has no date (review, Sep 20 2026). The first version
  // computed `j.dueAt && br.promisedAt ? gap : 0` and then counted gap===0 as
  // agreement — so the one outcome this change can actually produce by
  // accident, the board holding a date the project page has dropped, would
  // have passed the check vacuously. Six live jobs went quiet on the day this
  // shipped; a guard that reads a missing date as a perfect match is no guard.
  const probes: { hours: number; boardAt: string; boardFor: string; boardLate: boolean; briefAt: string; briefFor: string; briefLate: boolean; gapH: number | null; same: boolean }[] = [];
  for (const hours of [18, 24, 30, 36, 42, 48, 60, 72, 96]) {
    const N = await mk(`${hours} Windowpane Way`, { editorId: john.id, shootDate: ago(hours * HOUR), debriefSubmittedAt: ago(hours * HOUR) });
    const nOrder = order(2500 + hours, ...mixedTitles);
    await reconcileDeliverablesToOrder(N.id, nOrder);
    for (const title of mixedTitles) {
      await prisma.orderItem.create({ data: { projectId: N.id, title, quantity: 1, amount: 250 } });
    }
    await ensureOutputsForProject(N.id);
    // THE PROBE JOB NEEDS AN EVIDENCE BLOB (Sep 20 2026). Without one
    // evidenceTone returns "Never cross-checked" and reports no promise at
    // all — promiseFor is null on a job the page is perfectly happy to date —
    // so the label half of this guard was measuring the absence of a status
    // read rather than the promise. Same hourly sweep the mixed job above
    // runs, off the same signals: the photos are live on the listing, the reel
    // and the floor plan are not.
    const nDl = await prisma.deliverable.findMany({ where: { projectId: N.id, removedFromOrderAt: null }, select: { type: true, label: true, quantity: true } });
    const nOuts = await prisma.deliverableOutput.findMany({
      where: { projectId: N.id, removedFromOrderAt: null, waivedAt: null },
      select: { deliverableId: true, slot: true, category: true, deliveredAt: true, approvedAt: true },
    });
    const nTally = videoUnitTally(nDl, nOuts);
    const nNow = new Date();
    const nRes = computeStatus({
      expected: expectedCategories(nDl),
      aryeo: { photos: 38, videos: 0, floorPlans: 0, interactive: 0, delivery: "UNDELIVERED", cover: null, at: nNow.toISOString() },
      dropbox: { rawPhotos: 210, rawVideo: 6, finalPhotos: 38, finalVideo: 0, at: nNow.toISOString() },
      fulfilled: false,
      officeConfirmed: false,
      units: nTally ? [nTally] : [],
      scheduled: false, anyAppt: true, datedAppt: true, postponed: false,
      shootDate: ago(hours * HOUR), videoAnchor: ago(hours * HOUR), shootPending: false,
      dropboxUnavailable: false,
      revisionOpen: false,
      videoTier: "standard", videoType: "SOCIAL_REEL", monthlyContent: false,
      read: { aryeo: "ok", dropbox: "ok", error: null },
    });
    await prisma.project.update({
      where: { id: N.id },
      data: {
        statusEvidence: JSON.stringify(nRes.evidence),
        statusCheckedAt: nNow, evidenceAttemptedAt: nNow, evidenceSucceededAt: nNow, evidenceError: null,
      },
    });
    const b = await deliveryBoard();
    const j = [...b.today, ...b.tomorrow, ...b.upcoming, ...b.delivered].find((x) => x.id === N.id);
    const br = await projectBrief(N.id);
    if (!j || !br) continue;
    probes.push({
      hours,
      boardAt: j.dueAt?.toISOString() ?? "—", boardFor: j.dueFor ?? "—", boardLate: j.overdue,
      briefAt: br.promisedAt?.toISOString() ?? "—", briefFor: br.tone.promiseFor ?? "—", briefLate: br.overdue,
      gapH: j.dueAt && br.promisedAt ? Math.round((br.promisedAt.getTime() - j.dueAt.getTime()) / HOUR) : null,
      same: (j.dueAt?.getTime() ?? null) === (br.promisedAt?.getTime() ?? null),
    });
  }
  for (const p of probes) {
    console.log(`   shot ${String(p.hours).padStart(2)}h ago · board due ${p.boardAt} for "${p.boardFor}" late=${p.boardLate} · project page promise ${p.briefAt} for "${p.briefFor}" late=${p.briefLate} · gap ${p.gapH === null ? "ONE SIDE HAS NO DATE" : `${p.gapH}h`}`);
  }
  const sameMoment = probes.filter((p) => p.same).length;
  const disagree = probes.filter((p) => p.boardLate !== p.briefLate);
  ok("Kyle's board and the project page date the same job from the same moment", sameMoment === probes.length, `${sameMoment} of ${probes.length} agree`);
  ok("…and never disagree about whether a job is LATE", disagree.length === 0, disagree.map((p) => `shot ${p.hours}h ago: board=${p.boardLate} page=${p.briefLate}`).join(" | ") || "none");
  const wrongSubject = probes.filter((p) => p.briefFor !== p.boardFor);
  ok("…nor about WHAT the date is for", wrongSubject.length === 0, wrongSubject.map((p) => `shot ${p.hours}h ago: board="${p.boardFor}" page="${p.briefFor}"`).join(" | ") || "none");

  // (d2) THE THREE BRANCHES THAT WERE ONLY EVER CHECKED AGAINST PRODUCTION.
  // The promise rewrite of Sep 20 2026 was verified by reading live Neon rows,
  // which proves it worked that day and stops nothing from re-breaking it. One
  // fixture each, on the drill's own database (review, Sep 20 2026).
  //
  // One: a date the office set by hand, already past, on a job whose only
  // video row has been sent and stamped. Counting the rows says "nothing is
  // owed" and the office's date says otherwise — the office wins, because
  // Jordan setting a date IS the ruling that work is owed by then. 204 Spring
  // Ln is the live row: Kyle's board said LATE Sep 17, the page said on time.
  const OV = await mk("5 Override Row", { status: "REVISION", shootDate: ago(6 * DAY), dueOverrideAt: ago(2 * DAY), revisionRequestedAt: ago(1 * DAY), editorId: john.id });
  await reconcileDeliverablesToOrder(OV.id, order(3100, REEL));
  await prisma.orderItem.create({ data: { projectId: OV.id, title: REEL, quantity: 1, amount: 250 } });
  await ensureOutputsForProject(OV.id);
  await prisma.deliverableOutput.updateMany({ where: { projectId: OV.id }, data: { deliveredAt: ago(1 * DAY) } });
  const ovOuts = await outputsForProject(OV.id);
  const ovBrief = await projectBrief(OV.id);
  ok("the fixture really has every video row sent", ovOuts.length > 0 && ovOuts.every((o) => o.state === "sent"), ovOuts.map((o) => o.state).join(",") || "(none)");
  ok("a hand-set date already past is late even so", ovBrief?.overdue === true, `promise=${ovBrief?.promisedAt?.toISOString()} source=${ovBrief?.promiseSource} overdue=${ovBrief?.overdue}`);
  ok("…and the page says whose date it is", ovBrief?.promiseSource === "office", ovBrief?.promiseSource ?? "(none)");

  // Two: a DELIVERED job keeps printing the promise it was sold under. The
  // engine returns no date for a settled job — correct for a verdict, wrong
  // for a history — and this card is the only place on the project page that
  // shows the client-facing promise. 487 delivered rows carry one.
  const settledPin = ago(9 * DAY);
  const SD = await mk("6 Settled Way", { status: "DELIVERED", deliveredAt: ago(8 * DAY), promisedDueAt: settledPin });
  await reconcileDeliverablesToOrder(SD.id, order(3101, REEL));
  const sdBrief = await projectBrief(SD.id);
  ok("a delivered job still shows the promise it was given", sdBrief?.promisedAt?.getTime() === settledPin.getTime(), `${sdBrief?.promisedAt?.toISOString()} vs pin ${settledPin.toISOString()}`);
  ok("…named as a promise, not as an estimate", sdBrief?.promiseSource === "frozen", sdBrief?.promiseSource ?? "(none)");
  ok("…and is never called late for work that shipped", sdBrief?.overdue === false && sdBrief?.tone.kind !== "overdue", `overdue=${sdBrief?.overdue} tone=${sdBrief?.tone.kind}`);

  // Three: delivered, then the client asked for a change. The stored date is
  // one this job MET, so neither surface may print it — the red "LATE · Aug
  // 21" against September notes is what started the rewrite. A revision has no
  // clock of its own until Jordan sets one; that is still his open question.
  const RO = await mk("7 Reopened Way", { status: "REVISION", deliveredAt: ago(4 * DAY), revisionRequestedAt: ago(1 * DAY), promisedDueAt: ago(7 * DAY), editorId: john.id });
  await reconcileDeliverablesToOrder(RO.id, order(3102, REEL));
  const roBrief = await projectBrief(RO.id);
  const roBoard = await deliveryBoard();
  const roJob = [...roBoard.today, ...roBoard.tomorrow, ...roBoard.upcoming, ...roBoard.delivered].find((x) => x.id === RO.id);
  ok("a reopened job shows no date on the project page", roBrief?.promisedAt == null, roBrief?.promisedAt?.toISOString() ?? "(none)");
  ok("…nor on Kyle's board — the same nothing", roJob != null && roJob.dueAt == null, `found=${!!roJob} due=${roJob?.dueAt?.toISOString() ?? "(none)"}`);
  ok("…and is not called late against a promise it already kept", roBrief?.overdue === false, String(roBrief?.overdue));

  // (d3) AND THE OTHER CARD ON THAT PAGE READS THE SAME COLUMNS.
  // StatusEvidenceCard is an async server component with its own select, and
  // this drill has no renderer for it, so the guard is on the select itself.
  // It is not pedantry: PromiseInput marks promisedDueAt optional for callers
  // that build their own select, that card was the caller that left it out,
  // and measured on production Sep 20 2026 it disagreed with the Promise line
  // an inch above it on 14 of the 36 dated open jobs — on 80 W Lancaster Ave
  // Floor 2 that was a red "past it" over a card calling the job on time.
  const cardSrc = readFileSync("src/components/project/StatusEvidenceCard.tsx", "utf8");
  ok("StatusEvidenceCard asks for the frozen promise too", /^\s*promisedDueAt:\s*true,\s*$/m.test(cardSrc));
  ok("…and for the reason behind it, like the board", /^\s*promisedReason:\s*true,\s*$/m.test(cardSrc));

  // (e) AND IT IS NOT AN EXCEPTION — the job has an editor and a live ask.
  ok("the exceptions board does not call a staffed job unstaffed", !board5.rows.some((r) => r.id === `unassigned:${M.id}`));
  ok("…nor chase a verdict on a cut that already got one", !board5.rows.some((r) => r.id.startsWith("review:") && r.href.includes(M.id)));
  void mCut;

  // ---------------------------------------------------------------------
  console.log(`\n${"=".repeat(76)}`);
  console.log(fail === 0 ? `ALL CHECKS PASSED (${pass} passed)` : `${fail} FAILED, ${pass} passed`);
  if (fail) console.log(`FAILED: ${failures.join(" | ")}`);
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
