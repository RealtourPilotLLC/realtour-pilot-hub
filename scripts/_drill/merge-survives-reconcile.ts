/**
 * A MERGE THAT SURVIVES THE NEXT HOURLY SYNC (audit F01).
 *
 *   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && set -a && source .env; set +a \
 *   && npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/merge-survives-reconcile.ts
 *
 * Runs the shipped mergeProjectWork / unmergeProjectWork / reconcileDeliverablesToOrder
 * against an ISOLATED in-process PGlite Postgres. Production Neon is never
 * touched — DATABASE_URL is overwritten below before any app module loads.
 *
 * What it has to show: replaying the sync loop's exact call against each job's
 * OWN order changes nothing about a merge; a line added to a merged-away job's
 * order lands where the work is and can still be put back; and an undo after
 * new work on the survivor leaves no cut pointing at a deliverable on another
 * job.
 *
 * Scenario 0 is the BEFORE picture: the reconcile's only new input is the merge
 * marker, so hiding the marker runs the code exactly as it behaved at db6093a.
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
const PORT = 5498;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
delete process.env.AUTH_ENFORCE;

let pass = 0, fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const { mergeProjectWork, unmergeProjectWork } = await import("@/app/editing/actions");
  const { reconcileDeliverablesToOrder, orderDeliverables } = await import("@/lib/integrations/aryeo");
  const { mergeFrom, mergeKey } = await import("@/lib/projectMerge");
  const { buildEditorQueue } = await import("@/lib/editorQueue");

  type Order = Parameters<typeof reconcileDeliverablesToOrder>[1];
  const REEL = "Standard Video Highlight Reel";
  const PHOTOS = "Professional Photography";
  const FLOORPLAN = "2D Floorplan";
  const order = (number: number, ...titles: string[]): Order =>
    ({ id: `ord-${number}`, number, items: titles.map((t, i) => ({ id: `it-${number}-${i}`, title: t, quantity: 1, amount: 25000 })) }) as Order;

  // Guard the fixtures themselves: if the parser stopped reading these titles
  // the way it does today, every assertion below would pass for the wrong
  // reason.
  const reelTypes = orderDeliverables(order(1, REEL).items).map((d) => d.type);
  const photoTypes = orderDeliverables(order(1, PHOTOS).items).map((d) => d.type);
  console.log("=".repeat(74));
  console.log("A merge that survives the next hourly sync");
  console.log("=".repeat(74));
  console.log(`\n0. THE FIXTURES PARSE — "${REEL}" → ${reelTypes.join("+") || "(nothing)"}, "${PHOTOS}" → ${photoTypes.join("+") || "(nothing)"}`);
  ok("the reel line implies a video row", reelTypes.includes("SOCIAL_REEL") || reelTypes.includes("VIDEO"), reelTypes.join("+"));
  ok("the photography line implies photos and no video", photoTypes.includes("PHOTOS") && !photoTypes.some((t) => t === "VIDEO" || t === "SOCIAL_REEL"), photoTypes.join("+"));
  const VIDEO_TYPE = reelTypes.includes("SOCIAL_REEL") ? "SOCIAL_REEL" : "VIDEO";

  const client = await prisma.client.create({ data: { name: "Mike Flatley" }, select: { id: true } });
  const shooter = await prisma.teamMember.create({
    data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER", payPercent: 0.35, payFloor: 100 },
    select: { id: true },
  });

  let seq = 0;
  const mk = async (street: string, orderId: string) =>
    prisma.project.create({
      data: {
        title: `${street}, Royersford, PA`, clientId: client.id, status: "EDITING", aryeoOrderId: orderId,
        payableInvoice: 450, price: 450, shootDate: new Date(Date.now() - 4 * 86_400_000), photographerId: shooter.id,
      },
      select: { id: true },
    });
  const mkReel = async (projectId: string, label: string) =>
    prisma.deliverable.create({ data: { projectId, type: VIDEO_TYPE as "SOCIAL_REEL", label, quantity: 1, manual: false }, select: { id: true } });
  const mkPhotos = async (projectId: string) =>
    prisma.deliverable.create({ data: { projectId, type: "PHOTOS", label: PHOTOS, quantity: 1, manual: false }, select: { id: true } });

  // The sync loop's exact call, including the one gate above it (aryeo.ts:1795).
  const sweep = async (projectId: string, o: Order) => {
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { status: true } });
    if (["DELIVERED", "CANCELLED"].includes(p.status)) return { skipped: true, retired: [] as string[], added: [] as string[], restored: [] as string[] };
    const r = await reconcileDeliverablesToOrder(projectId, o);
    return { skipped: false, retired: r.retired, added: r.added, restored: r.restored };
  };
  const live = (projectId: string) => prisma.deliverable.count({ where: { projectId, removedFromOrderAt: null } });
  const onBoard = async (id: string) => {
    const q = await buildEditorQueue();
    return [...q.notDone, ...q.upcoming, ...q.done].some((r) => r.id === id);
  };
  const row = (id: string) => prisma.deliverable.findUniqueOrThrow({ where: { id }, select: { projectId: true, removedFromOrderAt: true, removedFromOrderNote: true } });

  // ---------------------------------------------------------------------
  console.log("\n1. THE SHAPE THE AUDIT FOUND — the same sweep with the marker hidden");
  // The reconcile's only new input is the merge marker. Take it away and the
  // function behaves exactly as it did before this fix, which is what the audit
  // recorded: the survivor's moved reel retired, the donor's reel re-minted.
  {
    const P = await mk("1 Audit Way", `ord-${++seq}`), Q = await mk("1 Audit Way", `ord-${++seq}`);
    const oP = order(1501, REEL), oQ = order(1502, REEL);
    await mkReel(P.id, "Original reel");
    const dQ = await mkReel(Q.id, "Second reel");
    await prisma.reviewSubmission.create({
      data: { projectId: Q.id, kind: "video", deliverableId: dQ.id, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "second-v1.mp4" },
    });
    ok("the merge is accepted", (await mergeProjectWork(Q.id, P.id, "second reel, same listing")).ok);
    const marker = await prisma.appSetting.findUniqueOrThrow({ where: { key: mergeKey(Q.id) }, select: { value: true } });
    await prisma.appSetting.delete({ where: { key: mergeKey(Q.id) } });
    const blindP = await sweep(P.id, oP), blindQ = await sweep(Q.id, oQ);
    ok("blind to the merge, the survivor retires the moved reel", blindP.retired.length === 1, JSON.stringify(blindP.retired));
    ok("blind to the merge, the donor re-mints the video it gave away", blindQ.added.length === 1, JSON.stringify(blindQ.added));
    ok("…and the cut is left pointing at a retired row", !!(await row(dQ.id)).removedFromOrderAt, (await row(dQ.id)).removedFromOrderNote ?? "");
    await prisma.appSetting.create({ data: { key: mergeKey(Q.id), value: marker.value } });
  }

  // ---------------------------------------------------------------------
  console.log("\n2. THE SAME SWEEP, WITH THE MERGE IN VIEW — same type on both orders");
  const A = await mk("204 Spring Ln", `ord-${++seq}`), B = await mk("204 Spring Ln", `ord-${++seq}`);
  const oA = order(1601, REEL), oB = order(1602, REEL);
  const dA = await mkReel(A.id, "Original reel");
  const dB = await mkReel(B.id, "Second reel");
  const cutB = await prisma.reviewSubmission.create({
    data: { projectId: B.id, kind: "video", deliverableId: dB.id, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "second-reel-v1.mp4" },
    select: { id: true },
  });
  await prisma.smartTask.create({
    data: { projectId: B.id, taskType: "edit_video", title: "Edit video — second reel", dedupeKey: `edit-video-${B.id}`, status: "OPEN", source: "hub", assignedKey: "kim", assignedManually: false },
  });
  ok("the merge is accepted", (await mergeProjectWork(B.id, A.id, "second reel, same listing")).ok);
  ok("the survivor owes both reels", (await live(A.id)) === 2);
  ok("the merged-away job owes nothing", (await live(B.id)) === 0);

  const rowsBefore = await prisma.deliverable.count();
  const sA = await sweep(A.id, oA), sB = await sweep(B.id, oB);
  ok("the survivor's sweep changes nothing", sA.retired.length === 0 && sA.added.length === 0 && sA.restored.length === 0, JSON.stringify(sA));
  ok("the merged-away job's sweep changes nothing", sB.retired.length === 0 && sB.added.length === 0 && sB.restored.length === 0, JSON.stringify(sB));
  ok("no row was minted anywhere", (await prisma.deliverable.count()) === rowsBefore);
  ok("the moved reel is still on the survivor, still owed", (await row(dB.id)).projectId === A.id && !(await row(dB.id)).removedFromOrderAt);
  ok("the survivor's own reel is untouched", !(await row(dA.id)).removedFromOrderAt);
  ok("the cut still belongs to the job holding the work", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cutB.id }, select: { projectId: true } })).projectId === A.id);
  ok("the edit card the merge carried over is still open", (await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `edit-video-${B.id}` }, select: { status: true, projectId: true } })).status === "OPEN");
  ok("ONE Editing Room row, and it is the job holding the work", (await onBoard(A.id)) && !(await onBoard(B.id)));

  console.log("\n3. AND AGAIN, AND AGAIN — an hourly sweep is not a one-off");
  for (let i = 0; i < 3; i++) { await sweep(A.id, oA); await sweep(B.id, oB); }
  ok("still two reels on the survivor", (await live(A.id)) === 2);
  ok("still nothing owed on the merged-away job", (await live(B.id)) === 0);
  ok("still nothing minted", (await prisma.deliverable.count()) === rowsBefore);

  // ---------------------------------------------------------------------
  console.log("\n4. NO TYPE COLLISION — the survivor's order never sold a video");
  {
    const C = await mk("7 Photo Row", `ord-${++seq}`), D = await mk("7 Photo Row", `ord-${++seq}`);
    const oC = order(1701, PHOTOS), oD = order(1702, REEL);
    await mkPhotos(C.id);
    const dD = await mkReel(D.id, "Second shoot reel");
    ok("the merge is accepted", (await mergeProjectWork(D.id, C.id)).ok);
    const sC = await sweep(C.id, oC), sD = await sweep(D.id, oD);
    ok("the photo-only order does not retire the video parked on it", sC.retired.length === 0, JSON.stringify(sC));
    ok("the video order does not re-mint its video", sD.added.length === 0, JSON.stringify(sD));
    ok("the moved reel is still owed on the survivor", (await row(dD.id)).projectId === C.id && !(await row(dD.id)).removedFromOrderAt);
  }

  // ---------------------------------------------------------------------
  console.log("\n5. A LINE ADDED TO THE MERGED-AWAY JOB'S ORDER");
  const oB2 = order(1602, REEL, FLOORPLAN);
  const sB2 = await sweep(B.id, oB2);
  ok("the new line is minted", sB2.added.length === 1, JSON.stringify(sB2.added));
  const plan = await prisma.deliverable.findFirstOrThrow({ where: { type: "FLOORPLAN" }, select: { id: true, projectId: true } });
  ok("…on the job that carries the work, not the one that holds the order", plan.projectId === A.id);
  ok("…and recorded in the marker, so the undo still knows whose it is", ((await mergeFrom(B.id))?.moved.deliverableIds ?? []).includes(plan.id));
  ok("a second sweep does not mint it twice", (await sweep(B.id, oB2)).added.length === 0);
  ok("the survivor's own sweep leaves the new row alone", (await sweep(A.id, oA)).retired.length === 0);
  ok("…and it is still owed", !(await row(plan.id)).removedFromOrderAt);

  // ---------------------------------------------------------------------
  console.log("\n6. PUT IT BACK, AFTER MORE WORK LANDED ON THE SURVIVOR");
  // Round 2 against the MOVED reel, uploaded after the merge — the row the
  // id-snapshot undo could not see.
  const round2 = await prisma.reviewSubmission.create({
    data: { projectId: A.id, kind: "video", deliverableId: dB.id, slot: 1, round: 2, status: "PENDING", source: "upload", fileName: "second-reel-v2.mp4" },
    select: { id: true },
  });
  const topaz = await prisma.topazJob.create({ data: { submissionId: round2.id, projectId: A.id, state: "done" }, select: { id: true } });
  // The per-video row the merge's own ensureOutputs pass already minted on the
  // survivor, or one made here if that pass found nothing to mint.
  const outputB = await prisma.deliverableOutput.upsert({
    where: { deliverableId_slot: { deliverableId: dB.id, slot: 1 } },
    create: { projectId: A.id, deliverableId: dB.id, slot: 1, category: VIDEO_TYPE, source: "quantity" },
    update: { projectId: A.id },
    select: { id: true },
  });
  // …and the survivor's OWN later work, which must not be dragged away.
  const ownCut = await prisma.reviewSubmission.create({
    data: { projectId: A.id, kind: "video", deliverableId: dA.id, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "original-v1.mp4" },
    select: { id: true },
  });

  const undo = await unmergeProjectWork(B.id);
  ok("the unmerge is accepted", undo.ok, undo.message);
  ok("the moved reel went home", (await row(dB.id)).projectId === B.id);
  ok("round 1 went with it", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cutB.id }, select: { projectId: true } })).projectId === B.id);
  ok("ROUND 2, uploaded after the merge, went with it too", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: round2.id }, select: { projectId: true } })).projectId === B.id);
  ok("its Topaz render followed the cut", (await prisma.topazJob.findUniqueOrThrow({ where: { id: topaz.id }, select: { projectId: true } })).projectId === B.id);
  ok("the per-video row followed its deliverable", (await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: outputB.id }, select: { projectId: true } })).projectId === B.id);
  ok("the floor plan minted during the merge went home as well", (await row(plan.id)).projectId === B.id);
  ok("the survivor's OWN cut stayed on the survivor", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: ownCut.id }, select: { projectId: true } })).projectId === A.id);
  ok("nothing is left pointing at a deliverable on another job", Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM "ReviewSubmission" s JOIN "Deliverable" d ON d.id = s."deliverableId" WHERE d."projectId" <> s."projectId"`,
  ))[0].n) === 0);
  ok("…and no per-video row either", Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM "DeliverableOutput" o JOIN "Deliverable" d ON d.id = o."deliverableId" WHERE d."projectId" <> o."projectId"`,
  ))[0].n) === 0);

  console.log("\n7. AND THE SWEEP AFTER THE UNDO IS QUIET TOO");
  const afterUndo = await prisma.deliverable.count();
  const uA = await sweep(A.id, oA), uB = await sweep(B.id, oB2);
  ok("the survivor keeps its own reel", uA.retired.length === 0 && uA.added.length === 0, JSON.stringify(uA));
  ok("the job that got its work back keeps it", uB.retired.length === 0 && uB.added.length === 0, JSON.stringify(uB));
  ok("nothing minted, nothing retired", (await prisma.deliverable.count()) === afterUndo);
  ok("both are back on the Editing Room", (await onBoard(A.id)) && (await onBoard(B.id)));

  // ---------------------------------------------------------------------
  console.log("\n8. THE SURVIVOR IS DELIVERED — which is what every finished merge looks like");
  // The pair delivers once, so the survivor goes DELIVERED while the donor keeps
  // EDITING for ever: it has no video rows left, so it is off the Editing Room
  // and nobody presses Completed on it. From then on the donor passes the sync's
  // status gate hourly, and everything it does lands on the delivered job.
  {
    const S = await mk("88 Delivered Dr", `ord-${++seq}`), T = await mk("88 Delivered Dr", `ord-${++seq}`);
    const dS = await mkReel(S.id, "Original reel");
    const dT = await mkReel(T.id, "Second reel");
    ok("the merge is accepted", (await mergeProjectWork(T.id, S.id)).ok);
    await prisma.project.update({ where: { id: S.id }, data: { status: "DELIVERED", deliveredAt: new Date() } });
    const before = await prisma.deliverable.count();

    const addLine = await sweep(T.id, order(1802, REEL, FLOORPLAN));
    ok("a line added to the merged-away job's order mints nothing on a delivered job", addLine.added.length === 0, JSON.stringify(addLine));
    ok("…and nothing on the merged-away job either", (await prisma.deliverable.count()) === before);

    const pullLine = await sweep(T.id, order(1802, PHOTOS));
    ok("a line pulled from its order retires nothing on the delivered job", pullLine.retired.length === 0, JSON.stringify(pullLine));
    ok("the delivered job's rows are exactly as they were", !(await row(dT.id)).removedFromOrderAt && !(await row(dS.id)).removedFromOrderAt);
    ok("…and the delivered job's timeline was not written to", (await prisma.activity.count({ where: { projectId: S.id, body: { contains: "Aryeo" } } })) === 0);
    ok("the merged-away job is still not on the Editing Room", !(await onBoard(T.id)));
  }

  // ---------------------------------------------------------------------
  console.log("\n9. THE MARKER APPEND IS THE PRECONDITION, NOT AN AFTERTHOUGHT");
  // The row and its marker entry land together or neither lands. Proved on the
  // shipped recordMergedRow, inside the shipped transaction shape: an append
  // that reports false takes the create down with it, so there is never a row on
  // the survivor that nothing can account for.
  {
    const { recordMergedRow } = await import("@/lib/projectMerge");
    const U = await mk("5 Rollback Rd", `ord-${++seq}`), V = await mk("5 Rollback Rd", `ord-${++seq}`);
    await mkReel(V.id, "Second reel");
    ok("the merge is accepted", (await mergeProjectWork(V.id, U.id)).ok);
    const before = await prisma.deliverable.count();

    // No marker for U (it is the survivor, not a donor), so the append reports
    // false — the same answer a marker that could not be read gives.
    let threw = false;
    await prisma
      .$transaction(async (tx) => {
        const d = await tx.deliverable.create({ data: { projectId: U.id, type: "FLOORPLAN", label: FLOORPLAN, quantity: 1, manual: false }, select: { id: true } });
        const recorded = await recordMergedRow(tx, U.id, "deliverableIds", d.id);
        if (!recorded) throw new Error("merge marker would not take the row");
        return d.id;
      })
      .catch(() => { threw = true; });
    ok("an append that cannot be made refuses the mint", threw);
    ok("…and no row was left behind on the job holding the work", (await prisma.deliverable.count()) === before);

    // And the append itself is safe when two sweeps mint for one order at once
    // (the :00 cron and an order.updated webhook), which is what the row lock is
    // for: neither id may be written back out of the marker by the other.
    const [x, y] = await Promise.all([
      prisma.deliverable.create({ data: { projectId: U.id, type: "PHOTOS", label: PHOTOS, quantity: 1, manual: false }, select: { id: true } }),
      prisma.deliverable.create({ data: { projectId: U.id, type: "FLOORPLAN", label: FLOORPLAN, quantity: 1, manual: false }, select: { id: true } }),
    ]);
    await Promise.all([
      prisma.$transaction((tx) => recordMergedRow(tx, V.id, "deliverableIds", x.id)),
      prisma.$transaction((tx) => recordMergedRow(tx, V.id, "deliverableIds", y.id)),
    ]);
    const after = (await mergeFrom(V.id))?.moved.deliverableIds ?? [];
    ok("two appends racing for one marker both survive", after.includes(x.id) && after.includes(y.id));
  }

  // ---------------------------------------------------------------------
  console.log("\n10. A ROW THE DONOR HAD ALREADY RETIRED, WHOSE TYPE COMES BACK");
  // previewMerge only carries rows that are still owed, so this one stayed
  // behind. Un-retiring it in place would put the merged-away job back on the
  // Editing Room owing a video nobody will find footage for.
  {
    const W = await mk("12 Revive Ct", `ord-${++seq}`), X = await mk("12 Revive Ct", `ord-${++seq}`);
    const oW = order(1901, PHOTOS);
    await mkPhotos(W.id);
    await mkPhotos(X.id);
    const stale = await mkReel(X.id, "Reel pulled from the order back in August");
    await prisma.deliverable.update({
      where: { id: stale.id },
      data: { removedFromOrderAt: new Date(Date.now() - 30 * 86_400_000), removedFromOrderNote: `'Second reel' is no longer on Aryeo order #1902` },
    });
    ok("the merge is accepted", (await mergeProjectWork(X.id, W.id)).ok);
    ok("the retired row stayed behind on the job that owned it", (await row(stale.id)).projectId === X.id);

    const revive = await sweep(X.id, order(1902, PHOTOS, REEL));
    ok("the retired row is NOT brought back to life on the merged-away job", revive.restored.length === 0, JSON.stringify(revive));
    ok("…it is still retired, with its note intact", !!(await row(stale.id)).removedFromOrderAt && (await row(stale.id)).projectId === X.id);
    ok("the live row is minted on the job that carries the work", revive.added.length === 1, JSON.stringify(revive.added));
    const fresh = await prisma.deliverable.findFirstOrThrow({ where: { projectId: W.id, type: VIDEO_TYPE as "SOCIAL_REEL", removedFromOrderAt: null }, select: { id: true } });
    ok("…and recorded in the marker, so it goes home on an undo", ((await mergeFrom(X.id))?.moved.deliverableIds ?? []).includes(fresh.id));
    ok("the merged-away job stays off the Editing Room", !(await onBoard(X.id)));
    ok("a second sweep mints nothing and revives nothing", JSON.stringify(await sweep(X.id, order(1902, PHOTOS, REEL))) === JSON.stringify({ skipped: false, retired: [], added: [], restored: [] }));
    ok("the survivor's own sweep leaves both alone", (await sweep(W.id, oW)).retired.length === 0);

    // …and the job holding the work says on its OWN page why its owed list moved.
    const mirrored = await prisma.activity.findMany({ where: { projectId: W.id, type: "SYSTEM" }, select: { body: true } });
    ok("the job holding the work says why its owed list changed", mirrored.some((a) => a.body.includes("#1902") && a.body.includes("whose work is here")), mirrored.map((a) => a.body).join(" | ").slice(0, 160));
  }

  // ---------------------------------------------------------------------
  console.log("\n11. NO CHAINS");
  {
    const Y = await mk("3 Chain Way", `ord-${++seq}`), Z = await mk("3 Chain Way", `ord-${++seq}`);
    const Z2 = await mk("3 Chain Way", `ord-${++seq}`), Z3 = await mk("3 Chain Way", `ord-${++seq}`);
    await mkReel(Y.id, "Original reel");
    await mkReel(Z.id, "Second reel");
    await mkReel(Z2.id, "Third reel");
    await mkPhotos(Z3.id);
    ok("the second shoot merges onto the original", (await mergeProjectWork(Z.id, Y.id)).ok);
    ok("a THIRD shoot may still join the job that carries the others", (await mergeProjectWork(Z2.id, Y.id)).ok);
    // Y now carries two other jobs' work. Moving Y itself onto a job that has
    // never been merged is the chain: the two markers would still name Y while
    // the rows had gone on to Z3.
    const chain = await mergeProjectWork(Y.id, Z3.id);
    ok("…but the job carrying them cannot itself be merged away", !chain.ok && /already carrying/.test(chain.message), chain.message);
    ok("the two merges it is carrying are untouched", !!(await mergeFrom(Z.id)) && !!(await mergeFrom(Z2.id)));
  }

  console.log(`\n${fail === 0 ? `ALL CHECKS PASSED (${pass} passed)` : `${fail} FAILED, ${pass} passed`}`);
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
