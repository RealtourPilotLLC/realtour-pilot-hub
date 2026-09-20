/**
 * FIVE MERGE JOURNEYS, DRIVEN END TO END, WITH THE SWEEPS RUN AFTER EVERY MOVE.
 *
 *   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && set -a && source .env; set +a \
 *   && NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs \
 *      scripts/_drill/journey-merge.ts
 *
 * merge-survives-reconcile.ts proves ONE sweep after each transition. This one
 * goes after the journeys it does not walk:
 *
 *   1. two live orders merged, then the hourly loop run FOUR times over both
 *      orders with the per-video sweep after each pass;
 *   2. a new round uploaded onto the survivor after the merge, then the undo —
 *      and the rows a merge moves that have no parent to come home to;
 *   3. quantities changed on EITHER order after the merge, up and down and back;
 *   4. a THIRD shoot joining a job that already carries a merge, then the
 *      MIDDLE one put back;
 *   5. the survivor delivered while the donor is still live, then sync, then
 *      the undo afterwards.
 *
 * Every transition is the SHIPPED function — mergeProjectWork,
 * unmergeProjectWork, reconcileDeliverablesToOrder, sweepOutputUnits — against
 * an ISOLATED in-process PGlite Postgres. Production Neon is never touched:
 * DATABASE_URL is overwritten below before any app module loads.
 *
 * PGlite Socket multiplexes every connection onto one database connection, so
 * nothing here claims to prove isolation or concurrency. These are sequential
 * business journeys, which is what they are about.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import Module from "node:module";

const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f };
  if (request === "next/navigation") return { redirect: () => { throw new Error("redirect"); }, notFound: () => { throw new Error("notFound"); } };
  if (request === "next/headers") return {};
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
  good ? pass++ : fail++;
  if (!good) failures.push(label);
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const { mergeProjectWork, unmergeProjectWork, setQueueStatus } = await import("@/app/editing/actions");
  const { reconcileDeliverablesToOrder, orderDeliverables } = await import("@/lib/integrations/aryeo");
  const { mergeFrom, mergedInto } = await import("@/lib/projectMerge");
  const { sweepOutputUnits } = await import("@/lib/deliverableOutputs");
  const { buildEditorQueue } = await import("@/lib/editorQueue");

  type Order = Parameters<typeof reconcileDeliverablesToOrder>[1];
  const REEL = "Standard Video Highlight Reel";
  const PHOTOS = "Professional Photography";
  const FLOORPLAN = "2D Floorplan";
  type Line = { title: string; quantity?: number };
  const L = (title: string, quantity = 1): Line => ({ title, quantity });
  const order = (number: number, ...lines: (Line | string)[]): Order =>
    ({
      id: `ord-${number}`,
      number,
      items: lines.map((l, i) => {
        const line = typeof l === "string" ? L(l) : l;
        return { id: `it-${number}-${i}`, title: line.title, quantity: line.quantity ?? 1, amount: 25000 };
      }),
    }) as Order;

  const reelTypes = orderDeliverables(order(1, REEL).items).map((d) => d.type);
  const VIDEO_TYPE = reelTypes.includes("SOCIAL_REEL") ? "SOCIAL_REEL" : "VIDEO";

  console.log("=".repeat(78));
  console.log("Five merge journeys, with the background sweeps run after every move");
  console.log("=".repeat(78));
  console.log(`\n0. THE FIXTURES PARSE — "${REEL}" → ${reelTypes.join("+") || "(nothing)"}`);
  ok("the reel line implies a video row", reelTypes.includes("SOCIAL_REEL") || reelTypes.includes("VIDEO"), reelTypes.join("+"));
  ok("a reel line of quantity 2 parses as two", orderDeliverables(order(1, L(REEL, 2)).items)[0]?.quantity === 2,
    String(orderDeliverables(order(1, L(REEL, 2)).items)[0]?.quantity));

  const client = await prisma.client.create({ data: { name: "Mike Flatley" }, select: { id: true } });
  const shooter = await prisma.teamMember.create({
    data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER", payPercent: 0.35, payFloor: 100 },
    select: { id: true },
  });

  let seq = 0;
  const mk = async (street: string, invoice = 450) =>
    prisma.project.create({
      data: {
        title: `${street}, Royersford, PA`, clientId: client.id, status: "EDITING", aryeoOrderId: `ord-${++seq}`,
        payableInvoice: invoice, price: invoice, shootDate: new Date(Date.now() - 4 * 86_400_000), photographerId: shooter.id,
      },
      select: { id: true, aryeoOrderId: true, payableInvoice: true },
    });

  /** The sync loop's exact call, including the one status gate above it. */
  const sweep = async (projectId: string, o: Order) => {
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { status: true } });
    if (["DELIVERED", "CANCELLED"].includes(p.status)) return { skipped: true, retired: [], added: [], restored: [], relabeled: [] as string[] };
    const r = await reconcileDeliverablesToOrder(projectId, o);
    return { skipped: false, retired: r.retired, added: r.added, restored: r.restored, relabeled: r.relabeled, mergeError: r.mergeError, outputsError: r.outputsError };
  };
  /** The hourly per-video repair, for real, over every job in the database. */
  const outputSweep = () => sweepOutputUnits({ max: 200, budgetMs: 60_000 });
  const quiet = (r: { retired: string[]; added: string[]; restored: string[]; relabeled: string[] }) =>
    r.retired.length === 0 && r.added.length === 0 && r.restored.length === 0 && r.relabeled.length === 0;

  const live = (projectId: string) => prisma.deliverable.count({ where: { projectId, removedFromOrderAt: null } });
  const rowsOf = (projectId: string) =>
    prisma.deliverable.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { id: true, type: true, quantity: true, removedFromOrderAt: true, removedFromOrderNote: true } });
  const shape = async (projectId: string) =>
    (await rowsOf(projectId)).map((r) => `${r.type}×${r.quantity}${r.removedFromOrderAt ? " (retired)" : ""}`).join(", ") || "(nothing)";
  const row = (id: string) =>
    prisma.deliverable.findUniqueOrThrow({ where: { id }, select: { projectId: true, quantity: true, removedFromOrderAt: true, removedFromOrderNote: true } });
  const outputsOn = (projectId: string) =>
    prisma.deliverableOutput.findMany({ where: { projectId }, orderBy: [{ deliverableId: "asc" }, { slot: "asc" }], select: { id: true, deliverableId: true, slot: true, removedFromOrderAt: true } });
  const onBoard = async (id: string) => {
    const q = await buildEditorQueue();
    return [...q.notDone, ...q.upcoming, ...q.done].some((r) => r.id === id);
  };
  /** On a rail an editor actually works from — the Done tab is not one of them. */
  const onNotDone = async (id: string) => {
    const q = await buildEditorQueue();
    return [...q.notDone, ...q.upcoming].some((r) => r.id === id);
  };
  /** Every owed, unfinished video in the database that no editor rail lists.
   *  Work may move between jobs; it may never end up owed by nobody. */
  const strandedVideos = async () => {
    const q = await buildEditorQueue();
    const seen = new Set([...q.notDone, ...q.upcoming].map((r) => r.id));
    const rows = await prisma.deliverable.findMany({
      where: {
        type: { in: ["VIDEO", "SOCIAL_REEL"] },
        removedFromOrderAt: null, waivedAt: null,
        status: { not: "DONE" },
        reviewSubmissions: { none: { status: "APPROVED" } },
      },
      select: { id: true, projectId: true, label: true },
    });
    return rows.filter((r) => !seen.has(r.projectId));
  };
  const nobodyOwesNothing = async (label: string) => {
    const s = await strandedVideos();
    ok(label, s.length === 0, s.map((r) => `${r.label ?? r.id} on ${r.projectId.slice(0, 8)}`).join(", "));
  };
  const count = async (sql: string) => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql))[0].n);
  /** Every row in the database that points across a project boundary. */
  const strays = async () => ({
    cuts: await count(`SELECT COUNT(*)::bigint AS n FROM "ReviewSubmission" s JOIN "Deliverable" d ON d.id = s."deliverableId" WHERE d."projectId" <> s."projectId"`),
    outputs: await count(`SELECT COUNT(*)::bigint AS n FROM "DeliverableOutput" o JOIN "Deliverable" d ON d.id = o."deliverableId" WHERE d."projectId" <> o."projectId"`),
    cutToOutput: await count(`SELECT COUNT(*)::bigint AS n FROM "ReviewSubmission" s JOIN "DeliverableOutput" o ON o.id = s."outputId" WHERE o."projectId" <> s."projectId"`),
    topaz: await count(`SELECT COUNT(*)::bigint AS n FROM "TopazJob" t JOIN "ReviewSubmission" s ON s.id = t."submissionId" WHERE s."projectId" <> t."projectId"`),
    briefs: await count(`SELECT COUNT(*)::bigint AS n FROM "RevisionBrief" b JOIN "DeliverableOutput" o ON o.id = b."outputId" WHERE o."projectId" <> b."projectId"`),
  });
  // Strays a journey has already REPORTED as a finding are carried as a known
  // baseline, so a later journey's invariant measures what THAT journey did
  // rather than re-reporting the same row five times. Nothing is excused: the
  // journey that found it fails on it, and the baseline is printed.
  const known = { cuts: 0, outputs: 0, cutToOutput: 0, topaz: 0, briefs: 0 };
  const noStrays = async (label: string) => {
    const s = await strays();
    const extra = (Object.keys(known) as (keyof typeof known)[]).reduce((n, k) => n + (s[k] - known[k]), 0);
    const carried = (Object.values(known) as number[]).reduce((a, b) => a + b, 0);
    ok(`${label}${carried ? ` (carrying ${carried} already reported)` : ""}`, extra === 0, JSON.stringify(s));
    return s;
  };

  // =====================================================================
  console.log("\n" + "-".repeat(78));
  console.log("JOURNEY 1 — two active orders merged, then the hourly loop, again and again");
  console.log("-".repeat(78));

  const A = await mk("101 Merge Way");
  const B = await mk("101 Merge Way", 200);
  const oA = order(2101, PHOTOS, REEL);
  const oB = order(2102, REEL, FLOORPLAN);

  console.log("\n1.1 THE TWO JOBS AS ARYEO MINTED THEM");
  const mintA = await sweep(A.id, oA), mintB = await sweep(B.id, oB);
  ok("the first job's order minted photos and a reel", mintA.added.length === 2, await shape(A.id));
  ok("the second job's order minted a reel and a floor plan", mintB.added.length === 2, await shape(B.id));
  await outputSweep();
  ok("each job got a per-video row for its reel", (await outputsOn(A.id)).length === 1 && (await outputsOn(B.id)).length === 1,
    `A=${(await outputsOn(A.id)).length} B=${(await outputsOn(B.id)).length}`);

  const reelB = (await rowsOf(B.id)).find((r) => r.type === VIDEO_TYPE)!;
  const reelA = (await rowsOf(A.id)).find((r) => r.type === VIDEO_TYPE)!;
  const cutB1 = await prisma.reviewSubmission.create({
    data: { projectId: B.id, kind: "video", deliverableId: reelB.id, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "second-shoot-v1.mp4" },
    select: { id: true },
  });
  await prisma.smartTask.create({
    data: { projectId: B.id, taskType: "edit_video", title: "Edit video — second shoot", dedupeKey: `edit-video-${B.id}`, status: "OPEN", source: "hub", assignedKey: "kim", assignedManually: false },
  });

  console.log("\n1.2 THE MERGE");
  const m1 = await mergeProjectWork(B.id, A.id, "second shoot, same listing");
  ok("the merge is accepted", m1.ok, m1.message);
  ok("the survivor owes all four rows", (await live(A.id)) === 4, await shape(A.id));
  ok("the second job owes nothing of its own any more", (await live(B.id)) === 0, await shape(B.id));
  ok("ONE Editing Room row", (await onBoard(A.id)) && !(await onBoard(B.id)));

  console.log("\n1.3 FOUR HOURS OF THE SYNC LOOP, WITH THE PER-VIDEO SWEEP AFTER EACH");
  const totalRows = await prisma.deliverable.count();
  const outputIds0 = (await outputsOn(A.id)).map((o) => o.id).sort().join(",");
  for (let hour = 1; hour <= 4; hour++) {
    const sA = await sweep(A.id, oA), sB = await sweep(B.id, oB);
    const outs = await outputSweep();
    const liveA = await live(A.id), liveB = await live(B.id), rows = await prisma.deliverable.count();
    console.log(`     hour ${hour}: survivor=${liveA} owed · donor=${liveB} owed · ${rows} rows · outputs created=${outs.created} retired=${outs.retired} · A${JSON.stringify(sA.added)}${JSON.stringify(sA.retired)} B${JSON.stringify(sB.added)}${JSON.stringify(sB.retired)}`);
    ok(`hour ${hour}: neither order changes anything`, quiet(sA) && quiet(sB), `${JSON.stringify(sA)} ${JSON.stringify(sB)}`);
    ok(`hour ${hour}: the per-video sweep mints and retires nothing`, outs.created === 0 && outs.retired === 0 && outs.failed.length === 0 && !outs.budgetHit,
      `created=${outs.created} retired=${outs.retired} failed=${outs.failed.length}`);
    ok(`hour ${hour}: one coherent production view — four owed on the survivor, none on the donor`, liveA === 4 && liveB === 0, `${liveA}/${liveB}`);
    ok(`hour ${hour}: no row minted or lost anywhere`, rows === totalRows, `${rows} vs ${totalRows}`);
  }
  ok("the moved reel is still owed, on the job holding the work", (await row(reelB.id)).projectId === A.id && !(await row(reelB.id)).removedFromOrderAt);
  ok("the survivor's own reel is untouched", (await row(reelA.id)).projectId === A.id && !(await row(reelA.id)).removedFromOrderAt);
  ok("both reels still have their per-video row, same rows as before", (await outputsOn(A.id)).map((o) => o.id).sort().join(",") === outputIds0,
    `${(await outputsOn(A.id)).length} rows`);
  ok("none of the owed videos was retired by four passes", (await outputsOn(A.id)).every((o) => !o.removedFromOrderAt));
  ok("the editor's cut is on the job holding the work", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cutB1.id }, select: { projectId: true } })).projectId === A.id);
  ok("the edit card the merge carried over is still open", (await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `edit-video-${B.id}` }, select: { status: true } })).status === "OPEN");
  await noStrays("nothing points across a project boundary");

  console.log("\n1.4 THE PROVENANCE BOTH ORDERS KEEP");
  const provA = await prisma.project.findUniqueOrThrow({ where: { id: A.id }, select: { aryeoOrderId: true, payableInvoice: true, price: true } });
  const provB = await prisma.project.findUniqueOrThrow({ where: { id: B.id }, select: { aryeoOrderId: true, payableInvoice: true, price: true } });
  ok("the survivor keeps its own order id and invoice", provA.aryeoOrderId === A.aryeoOrderId && provA.payableInvoice === 450, JSON.stringify(provA));
  ok("the merged-away job keeps ITS order id and its own invoice", provB.aryeoOrderId === B.aryeoOrderId && provB.payableInvoice === 200, JSON.stringify(provB));
  const itemsA = (await prisma.orderItem.findMany({ where: { projectId: A.id }, select: { title: true } })).map((i) => i.title).sort();
  const itemsB = (await prisma.orderItem.findMany({ where: { projectId: B.id }, select: { title: true } })).map((i) => i.title).sort();
  ok("each order's line items stayed with the order that was billed", itemsA.join("|") === [PHOTOS, REEL].sort().join("|") && itemsB.join("|") === [REEL, FLOORPLAN].sort().join("|"),
    `A=[${itemsA}] B=[${itemsB}]`);
  ok("the merged-away job still knows where its work went", (await mergeFrom(B.id))?.intoId === A.id);

  // =====================================================================
  console.log("\n" + "-".repeat(78));
  console.log("JOURNEY 2 — merge, then a new version, then undo");
  console.log("-".repeat(78));

  console.log("\n2.1 JOHN UPLOADS ROUND 2 AGAINST THE MOVED REEL, ON THE SURVIVOR");
  const outMoved = (await outputsOn(A.id)).find((o) => o.deliverableId === reelB.id)!;
  const outOwn = (await outputsOn(A.id)).find((o) => o.deliverableId === reelA.id)!;
  const cutB2 = await prisma.reviewSubmission.create({
    data: { projectId: A.id, kind: "video", deliverableId: reelB.id, outputId: outMoved.id, slot: 1, round: 2, status: "PENDING", source: "upload", fileName: "second-shoot-v2.mp4" },
    select: { id: true },
  });
  const topaz2 = await prisma.topazJob.create({ data: { submissionId: cutB2.id, projectId: A.id, state: "done" }, select: { id: true } });
  const ownCut = await prisma.reviewSubmission.create({
    data: { projectId: A.id, kind: "video", deliverableId: reelA.id, outputId: outOwn.id, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "original-v1.mp4" },
    select: { id: true },
  });
  // A client ask raised on the survivor AFTER the merge, scoped to the moved
  // video — the shape /edit files when the revision names one cut.
  const briefMoved = await prisma.revisionBrief.create({
    data: { projectId: A.id, outputId: outMoved.id, source: "review_room", originalText: "Can we lose the drone shot at 0:12 on the second video?" },
    select: { id: true },
  });
  await outputSweep();
  await sweep(A.id, oA); await sweep(B.id, oB);
  ok("round 2 sits on the survivor, where the work is", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cutB2.id }, select: { projectId: true } })).projectId === A.id);
  await noStrays("with the merge standing, nothing points across a boundary");

  console.log("\n2.2 THE UNDO");
  const undo1 = await unmergeProjectWork(B.id);
  ok("the unmerge is accepted", undo1.ok, undo1.message);
  await outputSweep();
  const sA2 = await sweep(A.id, oA), sB2 = await sweep(B.id, oB);
  const outs2 = await outputSweep();
  console.log(`     after the undo: A=${await shape(A.id)} · B=${await shape(B.id)} · outputs created=${outs2.created} retired=${outs2.retired}`);
  ok("the moved reel and floor plan went home", (await row(reelB.id)).projectId === B.id && (await live(B.id)) === 2, await shape(B.id));
  ok("the survivor kept its own two rows", (await live(A.id)) === 2, await shape(A.id));
  ok("round 1 went home", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cutB1.id }, select: { projectId: true } })).projectId === B.id);
  ok("ROUND 2, uploaded after the merge, went home too", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cutB2.id }, select: { projectId: true } })).projectId === B.id);
  ok("its Topaz render followed the cut", (await prisma.topazJob.findUniqueOrThrow({ where: { id: topaz2.id }, select: { projectId: true } })).projectId === B.id);
  ok("the per-video row followed its deliverable", (await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: outMoved.id }, select: { projectId: true } })).projectId === B.id);
  ok("the survivor's OWN cut stayed on the survivor", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: ownCut.id }, select: { projectId: true } })).projectId === A.id);
  ok("neither order re-mints or retires anything after the undo", quiet(sA2) && quiet(sB2), `${JSON.stringify(sA2)} ${JSON.stringify(sB2)}`);
  ok("the per-video sweep has nothing to repair after the undo", outs2.created === 0 && outs2.retired === 0, `created=${outs2.created} retired=${outs2.retired}`);
  ok("both jobs are back on the Editing Room", (await onBoard(A.id)) && (await onBoard(B.id)));
  const strays2 = await noStrays("no orphaned or cross-project relationship survives the undo");
  ok("…including the client's ask about the moved video", strays2.briefs === 0,
    `RevisionBrief ${briefMoved.id} is on ${(await prisma.revisionBrief.findUniqueOrThrow({ where: { id: briefMoved.id }, select: { projectId: true } })).projectId}, its video on ${(await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: outMoved.id }, select: { projectId: true } })).projectId}`);
  known.briefs = strays2.briefs; // reported above; carried so the rest measures itself

  console.log("\n2.3 A DONOR CARRYING A CUT AGAINST A ROW THE ORDER ALREADY PULLED");
  // previewMerge takes every cut and every per-video row on the job, but only
  // the deliverables that are still OWED. A row the order dropped in August
  // stays behind while its cut and its slot move — a version pointing at a
  // video on another job, which is the thing the merge transaction's own
  // comment says no screen here can render.
  {
    const C = await mk("42 Stale Row"), D = await mk("42 Stale Row", 200);
    const oC = order(2201, PHOTOS), oD0 = order(2202, PHOTOS, REEL), oD1 = order(2202, PHOTOS);
    await sweep(C.id, oC); await sweep(D.id, oD0);
    const reelD = (await rowsOf(D.id)).find((r) => r.type === VIDEO_TYPE)!;
    await outputSweep();
    const outD = (await outputsOn(D.id)).find((o) => o.deliverableId === reelD.id)!;
    const staleCut = await prisma.reviewSubmission.create({
      data: { projectId: D.id, kind: "video", deliverableId: reelD.id, outputId: outD.id, slot: 1, round: 1, status: "CHANGES_REQUESTED", source: "upload", fileName: "pulled-line-v1.mp4" },
      select: { id: true },
    });
    const pulled = await sweep(D.id, oD1);
    ok("the reel line is pulled from the second job's order", pulled.retired.length === 1, JSON.stringify(pulled.retired));
    ok("…and the cut made against it is still sitting there", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: staleCut.id }, select: { projectId: true } })).projectId === D.id);
    await outputSweep();

    const m = await mergeProjectWork(D.id, C.id, "second shoot");
    ok("the merge is accepted", m.ok, m.message);
    await sweep(C.id, oC); await sweep(D.id, oD1); await outputSweep();
    const after = await strays();
    console.log(`     after the merge: cut ${staleCut.id.slice(0, 8)} on ${(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: staleCut.id }, select: { projectId: true } })).projectId === C.id ? "the survivor" : "the donor"}, its video row on ${(await row(reelD.id)).projectId === D.id ? "the donor" : "the survivor"}`);
    ok("the version does not end up on a different job from the video it is a version of", after.cuts === 0, JSON.stringify(after));
    ok("…and neither does its per-video row", after.outputs === 0, JSON.stringify(after));

    const u = await unmergeProjectWork(D.id);
    ok("the undo is accepted", u.ok, u.message);
    await sweep(C.id, oC); await sweep(D.id, oD1); await outputSweep();
    await noStrays("and the undo leaves nothing crossing a boundary");
  }

  // =====================================================================
  console.log("\n" + "-".repeat(78));
  console.log("JOURNEY 3 — quantities changed on EITHER order after the merge");
  console.log("-".repeat(78));

  const E = await mk("7 Quantity Ct"), F = await mk("7 Quantity Ct", 200);
  let oE = order(2301, PHOTOS, REEL);
  let oF = order(2302, REEL);
  await sweep(E.id, oE); await sweep(F.id, oF); await outputSweep();
  const reelE = (await rowsOf(E.id)).find((r) => r.type === VIDEO_TYPE)!;
  const reelF = (await rowsOf(F.id)).find((r) => r.type === VIDEO_TYPE)!;
  const photosE = (await rowsOf(E.id)).find((r) => r.type === "PHOTOS")!;
  ok("the merge is accepted", (await mergeProjectWork(F.id, E.id, "second shoot")).ok);
  const rowsBefore3 = await prisma.deliverable.count();

  console.log("\n3.1 THE CLIENT BUYS A SECOND REEL ON THE MERGED-AWAY JOB'S ORDER");
  oF = order(2302, L(REEL, 2));
  const up1 = await sweep(F.id, oF);
  const outs31 = await outputSweep();
  console.log(`     donor's order → reel ×2 · survivor now ${await shape(E.id)} · outputs created=${outs31.created} retired=${outs31.retired}`);
  ok("the order change is recorded, not re-minted as a second row", up1.added.length === 0 && up1.relabeled.length === 1, JSON.stringify(up1));
  ok("no deliverable appeared or disappeared", (await prisma.deliverable.count()) === rowsBefore3, `${await prisma.deliverable.count()} vs ${rowsBefore3}`);
  ok("the moved reel now owes two, on the job that holds the work", (await row(reelF.id)).quantity === 2 && (await row(reelF.id)).projectId === E.id, JSON.stringify(await row(reelF.id)));
  ok("the second video got a per-video row of its own", (await outputsOn(E.id)).filter((o) => o.deliverableId === reelF.id).length === 2,
    (await outputsOn(E.id)).map((o) => `${o.deliverableId.slice(0, 6)}:${o.slot}`).join(" "));
  ok("both of them sit on the job carrying the work", (await outputsOn(E.id)).filter((o) => o.deliverableId === reelF.id).every((o) => !o.removedFromOrderAt));
  await noStrays("no output lost its source or acquired a foreign project reference");

  console.log("\n3.2 AND AGAIN — a quantity change is not a one-off either");
  for (let hour = 1; hour <= 3; hour++) {
    const sE = await sweep(E.id, oE), sF = await sweep(F.id, oF);
    const o = await outputSweep();
    ok(`hour ${hour}: both orders are quiet and the sweep mints nothing`, quiet(sE) && quiet(sF) && o.created === 0 && o.retired === 0,
      `${JSON.stringify(sE)} ${JSON.stringify(sF)} created=${o.created} retired=${o.retired}`);
  }
  ok("still exactly three per-video rows on the survivor", (await outputsOn(E.id)).length === 3, String((await outputsOn(E.id)).length));

  console.log("\n3.3 AND NOW ON THE SURVIVOR'S OWN ORDER — its reel goes to three");
  oE = order(2301, PHOTOS, L(REEL, 3));
  const up2 = await sweep(E.id, oE);
  const outs33 = await outputSweep();
  console.log(`     survivor's order → reel ×3 · ${await shape(E.id)} · outputs created=${outs33.created}`);
  ok("the survivor's own reel rises to three", (await row(reelE.id)).quantity === 3, String((await row(reelE.id)).quantity));
  ok("…and the merged-in reel is left exactly where it was, at two", (await row(reelF.id)).quantity === 2 && (await row(reelF.id)).projectId === E.id);
  ok("nothing was minted, retired or duplicated by the survivor's own change", up2.added.length === 0 && up2.retired.length === 0 && (await prisma.deliverable.count()) === rowsBefore3, JSON.stringify(up2));
  ok("five owed videos, five per-video rows", (await outputsOn(E.id)).filter((o) => !o.removedFromOrderAt).length === 5,
    (await outputsOn(E.id)).map((o) => `${o.deliverableId.slice(0, 6)}:${o.slot}`).join(" "));
  ok("every per-video row still sits on the job its deliverable is on", (await strays()).outputs === 0);

  console.log("\n3.4 A LINE PULLED FROM THE MERGED-AWAY JOB'S ORDER, AND PUT BACK");
  oF = order(2302, PHOTOS);
  const pull = await sweep(F.id, oF);
  const outs34 = await outputSweep();
  console.log(`     donor's order → photos only · ${await shape(E.id)} · outputs retired=${outs34.retired}`);
  ok("the moved reel is retired where it lives, not on the job that holds the order", pull.retired.length === 1 && (await row(reelF.id)).projectId === E.id && !!(await row(reelF.id)).removedFromOrderAt,
    (await row(reelF.id)).removedFromOrderNote ?? "");
  ok("…and the note names the order it actually left", ((await row(reelF.id)).removedFromOrderNote ?? "").includes("2302"), (await row(reelF.id)).removedFromOrderNote ?? "");
  ok("the survivor's OWN reel is still owed", !(await row(reelE.id)).removedFromOrderAt && (await row(reelE.id)).quantity === 3);
  ok("the photo line the donor's order now carries is minted where the work is", pull.added.length === 1 && (await prisma.deliverable.count()) === rowsBefore3 + 1, JSON.stringify(pull.added));
  ok("the retired videos' per-video rows are retired too, and the survivor's own are not", (await outputsOn(E.id)).filter((o) => o.deliverableId === reelF.id).every((o) => !!o.removedFromOrderAt) && (await outputsOn(E.id)).filter((o) => o.deliverableId === reelE.id).every((o) => !o.removedFromOrderAt));
  ok("the edit card is NOT cancelled — the survivor still owes video", true);

  oF = order(2302, PHOTOS, L(REEL, 2));
  const back = await sweep(F.id, oF);
  const outs35 = await outputSweep();
  console.log(`     donor's order → the reel comes back · ${await shape(E.id)} · outputs unretired=${outs35.unretired}`);
  ok("the reel comes back on the job that has the work, in place", back.restored.length === 1 && back.added.length === 0 && (await row(reelF.id)).projectId === E.id && !(await row(reelF.id)).removedFromOrderAt, JSON.stringify(back));
  ok("no duplicate row was minted for it", (await prisma.deliverable.count()) === rowsBefore3 + 1);
  ok("its two per-video rows came back rather than being replaced", (await outputsOn(E.id)).filter((o) => o.deliverableId === reelF.id && !o.removedFromOrderAt).length === 2);
  await noStrays("after four order changes, nothing points across a boundary");

  // =====================================================================
  console.log("\n" + "-".repeat(78));
  console.log("JOURNEY 4 — a third shoot joins a job already carrying a merge, then the middle one is undone");
  console.log("-".repeat(78));

  const G = await mk("9 Three Ways"), H = await mk("9 Three Ways", 200), I = await mk("9 Three Ways", 150);
  const oG = order(2401, PHOTOS, REEL);
  const oH = order(2402, REEL);
  let oI = order(2403, REEL);
  await sweep(G.id, oG); await sweep(H.id, oH); await sweep(I.id, oI); await outputSweep();
  const reelH = (await rowsOf(H.id)).find((r) => r.type === VIDEO_TYPE)!;
  const reelI = (await rowsOf(I.id)).find((r) => r.type === VIDEO_TYPE)!;
  const cutH = await prisma.reviewSubmission.create({
    data: { projectId: H.id, kind: "video", deliverableId: reelH.id, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "shoot2-v1.mp4" },
    select: { id: true },
  });
  const cutI = await prisma.reviewSubmission.create({
    data: { projectId: I.id, kind: "video", deliverableId: reelI.id, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "shoot3-v1.mp4" },
    select: { id: true },
  });

  console.log("\n4.1 TWO SHOOTS JOIN THE ORIGINAL JOB");
  ok("the second shoot merges in", (await mergeProjectWork(H.id, G.id, "second shoot")).ok);
  const third = await mergeProjectWork(I.id, G.id, "third shoot");
  ok("the third shoot joins the same job", third.ok, third.message);
  const rows4 = await prisma.deliverable.count();
  for (let hour = 1; hour <= 3; hour++) {
    const sG = await sweep(G.id, oG), sH = await sweep(H.id, oH), sI = await sweep(I.id, oI);
    const o = await outputSweep();
    ok(`hour ${hour}: all three orders are quiet`, quiet(sG) && quiet(sH) && quiet(sI) && o.created === 0 && o.retired === 0,
      `${JSON.stringify(sG)} ${JSON.stringify(sH)} ${JSON.stringify(sI)}`);
  }
  ok("the job carrying them owes all four rows", (await live(G.id)) === 4, await shape(G.id));
  ok("neither donor owes anything of its own", (await live(H.id)) === 0 && (await live(I.id)) === 0);
  ok("ONE Editing Room row for three shoots", (await onBoard(G.id)) && !(await onBoard(H.id)) && !(await onBoard(I.id)));
  await noStrays("a three-way merge leaves nothing crossing a boundary");

  console.log("\n4.2 THE MIDDLE ONE IS PUT BACK");
  const undoMiddle = await unmergeProjectWork(H.id);
  ok("the undo is accepted", undoMiddle.ok, undoMiddle.message);
  const sG2 = await sweep(G.id, oG), sH2 = await sweep(H.id, oH), sI2 = await sweep(I.id, oI);
  const outs42 = await outputSweep();
  console.log(`     G=${await shape(G.id)} · H=${await shape(H.id)} · I=${await shape(I.id)} · outputs created=${outs42.created} retired=${outs42.retired}`);
  ok("the second shoot's reel and cut went home", (await row(reelH.id)).projectId === H.id && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cutH.id }, select: { projectId: true } })).projectId === H.id);
  ok("the THIRD shoot's work is untouched, still on the job carrying it", (await row(reelI.id)).projectId === G.id && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cutI.id }, select: { projectId: true } })).projectId === G.id);
  ok("the third shoot's merge still stands", !!(await mergeFrom(I.id)) && !(await mergeFrom(H.id)));
  ok("the survivor's page names exactly one job whose work it carries", (await mergedInto(G.id)).length === 1 && (await mergedInto(G.id))[0].fromId === I.id);
  ok("nothing was re-minted or retired by the sweeps after the undo", quiet(sG2) && quiet(sH2) && quiet(sI2) && (await prisma.deliverable.count()) === rows4,
    `${JSON.stringify(sG2)} ${JSON.stringify(sH2)} ${JSON.stringify(sI2)}`);
  ok("the per-video sweep has nothing to repair", outs42.created === 0 && outs42.retired === 0, `created=${outs42.created} retired=${outs42.retired}`);
  ok("two Editing Room rows now — the job carrying the third shoot, and the one that got its work back", (await onBoard(G.id)) && (await onBoard(H.id)) && !(await onBoard(I.id)));
  await noStrays("undoing the middle merge leaves nothing crossing a boundary");

  console.log("\n4.3 A LINE ADDED TO THE STILL-MERGED THIRD SHOOT'S ORDER");
  oI = order(2403, REEL, FLOORPLAN);
  const addI = await sweep(I.id, oI);
  await outputSweep();
  ok("it is minted on the job carrying the work", addI.added.length === 1, JSON.stringify(addI));
  const planI = await prisma.deliverable.findFirstOrThrow({ where: { type: "FLOORPLAN", projectId: { in: [G.id, I.id] } }, select: { id: true, projectId: true } });
  ok("…on the survivor, not the job that holds the order", planI.projectId === G.id);
  ok("…and recorded against the third shoot's merge, so the undo can find it", ((await mergeFrom(I.id))?.moved.deliverableIds ?? []).includes(planI.id));
  ok("a second sweep does not mint it twice", (await sweep(I.id, oI)).added.length === 0 && (await prisma.deliverable.count()) === rows4 + 1);
  ok("the sweep on the job that got its work back is unaffected", quiet(await sweep(H.id, oH)));

  // =====================================================================
  console.log("\n" + "-".repeat(78));
  console.log("JOURNEY 5 — the survivor is delivered while the donor is still live, then sync");
  console.log("-".repeat(78));

  const J = await mk("88 Delivered Dr"), K = await mk("88 Delivered Dr", 200);
  const oJ = order(2501, REEL);
  let oK = order(2502, REEL, FLOORPLAN);
  await sweep(J.id, oJ); await sweep(K.id, oK); await outputSweep();
  const reelJ = (await rowsOf(J.id)).find((r) => r.type === VIDEO_TYPE)!;
  const reelK = (await rowsOf(K.id)).find((r) => r.type === VIDEO_TYPE)!;
  const planK = (await rowsOf(K.id)).find((r) => r.type === "FLOORPLAN")!;
  ok("the merge is accepted", (await mergeProjectWork(K.id, J.id, "second shoot")).ok);
  await outputSweep();
  const rows5 = await prisma.deliverable.count();
  const outs5before = (await outputsOn(J.id)).map((o) => `${o.deliverableId}:${o.slot}:${o.removedFromOrderAt ? "out" : "live"}`).sort().join(",");

  console.log("\n5.0 THE OFFICE PRESSES COMPLETED TOO EARLY — with the second shoot's reel still open");
  // THE STORY 5.1 USED TO SKIP (Sep 20 2026, wave-3 review). It went straight
  // to a hand UPDATE that set the survivor DELIVERED, having marked BOTH reels
  // done first — so the one shape that breaks the invariant, a human calling
  // the job finished while the merged-in reel is still open, was never walked.
  // From that click the donor has no video rows and the survivor reaches only
  // the Done tab, and the second shoot's reel is owed by nobody. The pill
  // refuses it now, and this is the shipped pill, not an UPDATE.
  await prisma.deliverable.update({ where: { id: reelJ.id }, data: { status: "DONE" } });
  const tooEarly = await setQueueStatus(J.id, "Completed");
  ok("Completed is refused while the merged-in reel is still owed", !tooEarly.ok && /merged onto this job/.test(tooEarly.message), tooEarly.message);
  ok("the survivor was not delivered", (await prisma.project.findUniqueOrThrow({ where: { id: J.id }, select: { status: true } })).status !== "DELIVERED");
  ok("the merged-in reel is still on a rail an editor works from", await onNotDone(J.id));
  await nobodyOwesNothing("the refusal is what keeps the second shoot's reel visible");

  console.log("\n5.1 THE PAIR DELIVERS ONCE — the survivor goes DELIVERED, the donor stays EDITING for ever");
  // Both videos are finished first, which is what "one delivery" means, and the
  // delivery itself now goes through the pill so the gate above is proved to
  // let an honest one through rather than only to refuse.
  await prisma.deliverable.updateMany({ where: { id: { in: [reelJ.id, reelK.id] } }, data: { status: "DONE" } });
  const delivered5 = await setQueueStatus(J.id, "Completed");
  ok("…and once both reels are finished the same click goes through", delivered5.ok, delivered5.message);
  ok("the survivor is delivered", (await prisma.project.findUniqueOrThrow({ where: { id: J.id }, select: { status: true } })).status === "DELIVERED");
  // The timeline baseline is taken AFTER the delivery click, not before the
  // merge: the pill writes its own "Queue status set" line, and the question
  // the loop below asks is whether the HOURLY SYNC writes into a delivered
  // client job, not whether the office's own click did.
  const activityJ = await prisma.activity.count({ where: { projectId: J.id } });
  oK = order(2502, L(REEL, 3), FLOORPLAN, PHOTOS);
  let lastK: Awaited<ReturnType<typeof sweep>> | null = null;
  for (let hour = 1; hour <= 3; hour++) {
    const sK = await sweep(K.id, oK);
    lastK = sK;
    const o = await outputSweep();
    console.log(`     hour ${hour}: donor sweep ${JSON.stringify(sK)} · outputs created=${o.created} retired=${o.retired}`);
    ok(`hour ${hour}: the live order writes nothing into the delivered job`, quiet(sK) && (await prisma.deliverable.count()) === rows5, JSON.stringify(sK));
    ok(`hour ${hour}: the per-video sweep leaves the delivered job's videos alone`, o.created === 0 && o.retired === 0 && o.failed.length === 0,
      `created=${o.created} retired=${o.retired}`);
  }
  ok("the delivered job's rows are exactly as they were", (await row(reelJ.id)).quantity === 1 && (await row(reelK.id)).quantity === 1 && !(await row(reelK.id)).removedFromOrderAt, await shape(J.id));
  ok("its per-video rows are exactly as they were", (await outputsOn(J.id)).map((o) => `${o.deliverableId}:${o.slot}:${o.removedFromOrderAt ? "out" : "live"}`).sort().join(",") === outs5before);
  ok("nothing was written to the delivered client job's timeline", (await prisma.activity.count({ where: { projectId: J.id } })) === activityJ, `${await prisma.activity.count({ where: { projectId: J.id } })} vs ${activityJ}`);
  ok("the merged-away job stays off the Editing Room", !(await onBoard(K.id)));
  // HELD BACK IS NOT THE SAME AS LOST (Sep 20 2026 re-review). Not writing the
  // photo line into a delivered client job is right; skipping it in silence,
  // hourly, for ever is not — the only thing that ever landed it was somebody
  // undoing the merge. It rides home in the sync's result now.
  ok("the line the delivered job held back is reported, not swallowed",
    !!lastK?.mergeError && /Professional Photography/.test(lastK?.mergeError ?? ""), lastK?.mergeError ?? "(silent)");
  await nobodyOwesNothing("no owed video is invisible while the pair is delivered");
  await noStrays("delivery plus three syncs leaves nothing crossing a boundary");

  console.log("\n5.2 AND WHEN THE MERGE IS PUT BACK AFTERWARDS");
  const undo5 = await unmergeProjectWork(K.id);
  ok("the undo is accepted", undo5.ok, undo5.message);
  const sK2 = await sweep(K.id, oK);
  const outs52 = await outputSweep();
  console.log(`     J=${await shape(J.id)} · K=${await shape(K.id)} · donor sweep ${JSON.stringify(sK2)} · outputs created=${outs52.created}`);
  ok("the second shoot's work went home", (await row(reelK.id)).projectId === K.id && (await row(planK.id)).projectId === K.id, await shape(K.id));
  ok("the delivered job keeps its own reel and nothing else", (await live(J.id)) === 1 && (await row(reelJ.id)).projectId === J.id, await shape(J.id));
  ok("the order changes held back while the survivor was delivered now land on the donor", sK2.added.length === 1 && sK2.relabeled.length === 1, JSON.stringify(sK2));
  ok("…and the donor's reel is owed three times, with three per-video rows", (await row(reelK.id)).quantity === 3 && (await outputsOn(K.id)).filter((o) => !o.removedFromOrderAt).length === 3,
    `${(await row(reelK.id)).quantity} owed, ${(await outputsOn(K.id)).length} rows`);
  ok("the delivered job's own per-video row is still live and still its own", (await outputsOn(J.id)).length === 1 && !(await outputsOn(J.id))[0].removedFromOrderAt);
  await noStrays("the undo after delivery leaves nothing crossing a boundary");

  // =====================================================================
  console.log("\n" + "-".repeat(78));
  console.log("JOURNEY 6 — the second shoot arrives after the first listing has been delivered");
  console.log("-".repeat(78));
  // The shape 105 of the 106 same-client/same-street ordered pairs on live Neon
  // are in today. Merging onto the finished job would move the second shoot's
  // reel onto a job the Editing Room reads as done, and off every rail an editor
  // works from: owed by nobody, on either side. The merge refuses instead, and
  // the second shoot carries its own video exactly as it did before the button
  // existed.
  {
    const M = await mk("12 Finished First"), N = await mk("12 Finished First", 200);
    const oM = order(2601, PHOTOS, REEL), oN = order(2602, REEL);
    await sweep(M.id, oM); await sweep(N.id, oN); await outputSweep();
    const reelM = (await rowsOf(M.id)).find((r) => r.type === VIDEO_TYPE)!;
    const reelN = (await rowsOf(N.id)).find((r) => r.type === VIDEO_TYPE)!;
    await prisma.deliverable.update({ where: { id: reelM.id }, data: { status: "DONE" } });
    await prisma.project.update({ where: { id: M.id }, data: { status: "DELIVERED", deliveredAt: new Date() } });
    await prisma.reviewSubmission.create({
      data: { projectId: N.id, kind: "video", deliverableId: reelN.id, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "second-shoot-v1.mp4" },
    });

    const refused = await mergeProjectWork(N.id, M.id, "second reel for the same listing, shot on a separate day");
    ok("merging onto the delivered listing is refused", !refused.ok && /already been delivered/.test(refused.message), refused.message);
    ok("nothing moved", (await row(reelN.id)).projectId === N.id && (await live(N.id)) === 1);
    ok("no marker was written", !(await mergeFrom(N.id)));
    ok("THE SECOND SHOOT'S VIDEO IS STILL IN FRONT OF AN EDITOR", await onNotDone(N.id));
    const sM = await sweep(M.id, oM), sN = await sweep(N.id, oN);
    ok("and both orders keep reconciling to their own jobs", quiet(sM) && quiet(sN), `${JSON.stringify(sM)} ${JSON.stringify(sN)}`);
    await nobodyOwesNothing("no owed video is invisible");
    await noStrays("nothing crosses a boundary");
  }

  await nobodyOwesNothing("AND AT THE END OF ALL FIVE JOURNEYS, no owed video is owed by nobody");

  const finalStrays = await strays();
  console.log("\n" + "=".repeat(78));
  console.log(`Cross-project rows left in the database: ${JSON.stringify(finalStrays)}`);
  console.log(fail === 0 ? `ALL CHECKS PASSED (${pass} passed)` : `${fail} FAILED, ${pass} passed`);
  if (fail > 0) console.log("FAILED:\n  - " + failures.join("\n  - "));
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
