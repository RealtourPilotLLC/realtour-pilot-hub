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
  const { mergeProjectWork, unmergeProjectWork, setQueueStatus } = await import("@/app/editing/actions");
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
    if (["DELIVERED", "CANCELLED"].includes(p.status)) {
      return { skipped: true, retired: [] as string[], added: [] as string[], restored: [] as string[], mergeError: null as string | null };
    }
    const r = await reconcileDeliverablesToOrder(projectId, o);
    return { skipped: false, retired: r.retired, added: r.added, restored: r.restored, mergeError: r.mergeError ?? null };
  };
  const live = (projectId: string) => prisma.deliverable.count({ where: { projectId, removedFromOrderAt: null } });
  const onBoard = async (id: string) => {
    const q = await buildEditorQueue();
    return [...q.notDone, ...q.upcoming, ...q.done].some((r) => r.id === id);
  };
  // ON A RAIL AN EDITOR WORKS FROM — which is NOT the same question as onBoard
  // (Sep 20 2026 re-review). The Done tab counts as "on the board" and counts
  // for nothing as work: a job that reaches only the Done tab has no owed row
  // in front of anybody. Scenario 8 used to assert invisibility as a PASS
  // through exactly that confusion, so the two questions are now two helpers.
  const onNotDone = async (id: string) => {
    const q = await buildEditorQueue();
    return [...q.notDone, ...q.upcoming].some((r) => r.id === id);
  };
  /** Every owed, unfinished video in the database that no editor rail lists.
   *  The invariant the whole of F01 is about: work may move, but it may never
   *  end up owed by nobody. */
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
  console.log("\n8. A JOB THAT HAS ALREADY DELIVERED CANNOT TAKE THE WORK");
  // THE REGRESSION THIS SCENARIO USED TO BLESS (Sep 20 2026 re-review). It
  // merged a second shoot onto a job, delivered that job, and then asserted
  // "the merged-away job is still not on the Editing Room" as a PASS — with an
  // onBoard helper that counts the Done tab. Both jobs were off every rail an
  // editor works from and the second shoot's reel was owed by NOBODY, which is
  // worse than the bug it replaced (the donor at least re-minted it: the wrong
  // job, but visible). The merge now refuses a destination the Editing Room
  // cannot show, and the work stays exactly where it can be seen.
  {
    const S = await mk("88 Delivered Dr", `ord-${++seq}`), T = await mk("88 Delivered Dr", `ord-${++seq}`);
    const dS = await mkReel(S.id, "Original reel");
    const dT = await mkReel(T.id, "Second reel");
    await prisma.reviewSubmission.create({
      data: { projectId: T.id, kind: "video", deliverableId: dT.id, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "second-shoot-v1.mp4" },
    });
    // The original listing finished and went out weeks ago — the shape 105 of
    // the 106 same-client/same-street pairs on live Neon are in today.
    await prisma.deliverable.update({ where: { id: dS.id }, data: { status: "DONE" } });
    await prisma.project.update({ where: { id: S.id }, data: { status: "DELIVERED", deliveredAt: new Date() } });

    const refused = await mergeProjectWork(T.id, S.id, "second shoot on a finished listing");
    ok("merging onto a delivered job is refused", !refused.ok && /already been delivered/.test(refused.message), refused.message);
    // The copy is load-bearing (Sep 20 2026 wave-3 review): it must say what to
    // do instead, must NOT claim the Editing Room cannot show a delivered job
    // (OWES_AN_ADDITIONAL_SHOOT admits one), and must not advise putting the
    // job back into production without naming what that restarts.
    ok("…and it says what to do instead", /finish this one on its own/.test(refused.message), refused.message);
    ok("…without claiming the rail can never show a delivered job", !/reads it as finished/.test(refused.message), refused.message);
    ok("…and without recommending the one move the sync gate exists to prevent",
      !/put .* back into production first/.test(refused.message) && /restarts order syncing/.test(refused.message), refused.message);
    ok("nothing moved", (await row(dT.id)).projectId === T.id && (await live(T.id)) === 1);
    ok("no marker was written", !(await mergeFrom(T.id)));
    ok("THE SECOND SHOOT'S VIDEO IS STILL IN FRONT OF AN EDITOR", await onNotDone(T.id));
    await nobodyOwesNothing("no owed video is left invisible");

    // Same test for a destination no rail lists for another reason.
    await prisma.project.update({ where: { id: S.id }, data: { status: "ON_HOLD", deliveredAt: null } });
    const held = await mergeProjectWork(T.id, S.id);
    ok("merging onto a job that is on hold is refused too", !held.ok && /on hold/.test(held.message), held.message);
    await prisma.project.update({ where: { id: S.id }, data: { status: "EDITING" } });
    ok("the delivered job's own reel is untouched by any of that", !(await row(dS.id)).removedFromOrderAt && (await row(dS.id)).projectId === S.id);
  }

  console.log("\n8b. …AND WHEN THE SURVIVOR DELIVERS AFTER THE MERGE, THE GATE HOLDS");
  // The honest shape: merged while both were live, finished together, delivered
  // once. From then on the donor still passes the sync's status gate hourly, and
  // nothing it does may be written into the delivered client job.
  {
    const S = await mk("90 Finished Way", `ord-${++seq}`), T = await mk("90 Finished Way", `ord-${++seq}`);
    const dS = await mkReel(S.id, "Original reel");
    const dT = await mkReel(T.id, "Second reel");
    ok("the merge is accepted while both jobs are live", (await mergeProjectWork(T.id, S.id)).ok);
    ok("the work is on a rail an editor works from", await onNotDone(S.id));
    // Both videos finished, then the pair delivers once.
    await prisma.deliverable.updateMany({ where: { id: { in: [dS.id, dT.id] } }, data: { status: "DONE" } });
    await prisma.project.update({ where: { id: S.id }, data: { status: "DELIVERED", deliveredAt: new Date() } });
    const before = await prisma.deliverable.count();

    const addLine = await sweep(T.id, order(1802, REEL, FLOORPLAN));
    ok("a line added to the merged-away job's order mints nothing on a delivered job", addLine.added.length === 0, JSON.stringify(addLine));
    ok("…and nothing on the merged-away job either", (await prisma.deliverable.count()) === before);
    ok("…but the sweep SAYS the line is owed by nobody instead of swallowing it",
      !!addLine.mergeError && /Floorplan/i.test(addLine.mergeError ?? ""), addLine.mergeError ?? "(silent)");

    const pullLine = await sweep(T.id, order(1802, PHOTOS));
    ok("a line pulled from its order retires nothing on the delivered job", pullLine.retired.length === 0, JSON.stringify(pullLine));
    ok("the delivered job's rows are exactly as they were", !(await row(dT.id)).removedFromOrderAt && !(await row(dS.id)).removedFromOrderAt);
    ok("…and the delivered job's timeline was not written to", (await prisma.activity.count({ where: { projectId: S.id, body: { contains: "Aryeo" } } })) === 0);
    await nobodyOwesNothing("nothing owed is invisible once the pair has delivered");
  }

  console.log("\n8c. …AND THE HUMAN PATH CANNOT DELIVER THE MERGED-IN VIDEO AWAY");
  // THE HALF SCENARIO 8'S REFUSAL DOES NOT REACH (Sep 20 2026, wave-3 review).
  // Merging onto a LIVE job is the feature's own shape and stays allowed. The
  // silence just arrives one step later: somebody presses Completed on the
  // survivor with the merged-in reel still open, and from that instant the
  // donor has no video rows (buildEditorQueue drops it) and the survivor is
  // DELIVERED (the Done tab, nothing else). Scenarios 8 and 8b both finish
  // EVERY video before delivering, so neither ever asked this question and the
  // strandedVideos invariant was never pointed at the one case that breaks it.
  // This one asks it, through the shipped pill (setQueueStatus), not a hand
  // UPDATE — and asks the other half too, that an honest Completed still goes
  // through.
  {
    const U = await mk("92 Half Done Ln", `ord-${++seq}`), V = await mk("92 Half Done Ln", `ord-${++seq}`);
    const dU = await mkReel(U.id, "Original reel");
    const dV = await mkReel(V.id, "Second reel");
    ok("the merge is accepted while both jobs are live", (await mergeProjectWork(V.id, U.id)).ok);
    // Only the survivor's OWN reel is finished. The merged-in one is still open.
    await prisma.deliverable.update({ where: { id: dU.id }, data: { status: "DONE" } });
    const statusOf = async (id: string) => (await prisma.project.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

    const early = await setQueueStatus(U.id, "Completed");
    ok("Completed is refused while the merged-in reel is still owed", !early.ok && /merged onto this job/.test(early.message), early.message);
    ok("…and the refusal names all three ways past it",
      /Review Room/.test(early.message) && /waive/.test(early.message) && /undo the merge/.test(early.message), early.message);
    ok("nothing was delivered", (await statusOf(U.id)) !== "DELIVERED");
    ok("the merged-in reel is still in front of an editor", await onNotDone(U.id));
    await nobodyOwesNothing("the refusal is what keeps the merged-in reel visible");

    // The honest way through: the editor finishes it and Jordan approves it.
    await prisma.reviewSubmission.create({
      data: { projectId: U.id, kind: "video", deliverableId: dV.id, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "second-v1.mp4" },
    });
    const through = await setQueueStatus(U.id, "Completed");
    ok("…and once the merged-in cut is approved, Completed goes through", through.ok, through.message);
    ok("the survivor is delivered", (await statusOf(U.id)) === "DELIVERED");
    await nobodyOwesNothing("and nothing is owed by nobody once the pair really is finished");

    // The gate reads the marker, so it must not survive the undo: put the work
    // back and a Completed on the survivor is the survivor's own business again.
    const W = await mk("94 Undone Way", `ord-${++seq}`), X = await mk("94 Undone Way", `ord-${++seq}`);
    const dW = await mkReel(W.id, "Original reel");
    await mkReel(X.id, "Second reel");
    ok("a second pair merges", (await mergeProjectWork(X.id, W.id)).ok);
    // Its own reel is finished — the only thing open is the one that arrived.
    await prisma.deliverable.update({ where: { id: dW.id }, data: { status: "DONE" } });
    const refusedW = await setQueueStatus(W.id, "Completed");
    ok("Completed is refused on it too, and for the merge reason", !refusedW.ok && /merged onto this job/.test(refusedW.message), refusedW.message);
    ok("the undo is accepted", (await unmergeProjectWork(X.id)).ok);
    const afterUndo8c = await setQueueStatus(W.id, "Completed");
    ok("…and after the undo the gate lets the survivor's own delivery through", afterUndo8c.ok, afterUndo8c.message);
    ok("the second shoot kept its video, on its own rail", await onNotDone(X.id));
    await nobodyOwesNothing("the undone pair leaves nothing owed by nobody");
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
    ok("a second sweep mints nothing and revives nothing", JSON.stringify(await sweep(X.id, order(1902, PHOTOS, REEL))) === JSON.stringify({ skipped: false, retired: [], added: [], restored: [], mergeError: null }));
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

  // ---------------------------------------------------------------------
  console.log("\n12. A MARKER NOBODY CAN READ FAILS CLOSED — AND SAYS SO");
  // "Unknown beats wrong" was already the rule; the skip was silent, so a
  // persistent failure of this one read disabled ALL deliverable reconciliation
  // hub-wide, hourly, with nothing raised anywhere.
  {
    const AA = await mk("6 Broken Marker Ln", `ord-${++seq}`), BB = await mk("6 Broken Marker Ln", `ord-${++seq}`);
    const oBB = order(2001, REEL);
    await mkReel(AA.id, "Original reel");
    const dBB = await mkReel(BB.id, "Second reel");
    ok("the merge is accepted", (await mergeProjectWork(BB.id, AA.id)).ok);
    const key = mergeKey(BB.id);
    const good = (await prisma.appSetting.findUniqueOrThrow({ where: { key }, select: { value: true } })).value;
    await prisma.appSetting.update({ where: { key }, data: { value: "{not json at all" } });

    const rowsBefore12 = await prisma.deliverable.count();
    const blind = await sweep(BB.id, oBB);
    ok("the reconcile writes nothing at all", blind.added.length === 0 && blind.retired.length === 0 && (await prisma.deliverable.count()) === rowsBefore12, JSON.stringify(blind));
    ok("…and the skip rides home in the sync's result", !!blind.mergeError && /marker/i.test(blind.mergeError ?? ""), blind.mergeError ?? "(silent)");
    ok("the moved reel is untouched", (await row(dBB.id)).projectId === AA.id && !(await row(dBB.id)).removedFromOrderAt);
    await prisma.appSetting.update({ where: { key }, data: { value: good } });
    ok("and with the marker readable again the sweep is quiet", (await sweep(BB.id, oBB)).mergeError === null);
    await unmergeProjectWork(BB.id);
  }

  // ---------------------------------------------------------------------
  console.log("\n13. A CHILD FOLLOWS ITS PARENT, BOTH WAYS");
  // previewMerge took every cut, per-video row and brief on the donor while
  // filtering the deliverables to what is still owed, so a cut against a row the
  // order dropped in August moved without its row. And the undo moved the
  // client's ask by the merge-time id snapshot, so an ask filed on the survivor
  // after the merge never went home.
  {
    const CC = await mk("42 Stale Row", `ord-${++seq}`), DD = await mk("42 Stale Row", `ord-${++seq}`);
    await mkPhotos(CC.id);
    const liveReel = await mkReel(DD.id, "Second reel");
    const dropped = await mkReel(DD.id, "Reel the order dropped in August");
    await prisma.deliverable.update({
      where: { id: dropped.id },
      data: { removedFromOrderAt: new Date(Date.now() - 30 * 86_400_000), removedFromOrderNote: "'Reel' is no longer on Aryeo order #2102" },
    });
    const staleOut = await prisma.deliverableOutput.create({
      data: { projectId: DD.id, deliverableId: dropped.id, slot: 1, category: VIDEO_TYPE, source: "quantity" },
      select: { id: true },
    });
    const staleCut = await prisma.reviewSubmission.create({
      data: { projectId: DD.id, kind: "video", deliverableId: dropped.id, outputId: staleOut.id, slot: 1, round: 1, status: "CHANGES_REQUESTED", source: "upload", fileName: "dropped-v1.mp4" },
      select: { id: true },
    });
    const staleTopaz = await prisma.topazJob.create({ data: { submissionId: staleCut.id, projectId: DD.id, state: "done" }, select: { id: true } });
    const liveOut = await prisma.deliverableOutput.create({
      data: { projectId: DD.id, deliverableId: liveReel.id, slot: 1, category: VIDEO_TYPE, source: "quantity" },
      select: { id: true },
    });

    ok("the merge is accepted", (await mergeProjectWork(DD.id, CC.id, "second shoot")).ok);
    ok("the cut against the dropped row stayed with its row", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: staleCut.id }, select: { projectId: true } })).projectId === DD.id);
    ok("…so did its per-video row", (await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: staleOut.id }, select: { projectId: true } })).projectId === DD.id);
    ok("…and its Topaz render", (await prisma.topazJob.findUniqueOrThrow({ where: { id: staleTopaz.id }, select: { projectId: true } })).projectId === DD.id);
    ok("the live reel and its per-video row moved", (await row(liveReel.id)).projectId === CC.id && (await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: liveOut.id }, select: { projectId: true } })).projectId === CC.id);
    ok("nothing points at a deliverable on another job", Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM "ReviewSubmission" s JOIN "Deliverable" d ON d.id = s."deliverableId" WHERE d."projectId" <> s."projectId"`,
    ))[0].n) === 0);
    ok("…and no per-video row does either", Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM "DeliverableOutput" o JOIN "Deliverable" d ON d.id = o."deliverableId" WHERE d."projectId" <> o."projectId"`,
    ))[0].n) === 0);

    // The client rings about the second shoot's video AFTER the merge; /edit
    // files the ask on the job holding the work, scoped to that video.
    const askAboutMoved = await prisma.revisionBrief.create({
      data: { projectId: CC.id, outputId: liveOut.id, source: "review_room", originalText: "Can we lose the drone shot at 0:12 on the second video?" },
      select: { id: true },
    });
    const askAboutTheJob = await prisma.revisionBrief.create({
      data: { projectId: CC.id, source: "manual", originalText: "Agent wants everything a touch warmer." },
      select: { id: true },
    });
    const u = await unmergeProjectWork(DD.id);
    ok("the undo is accepted", u.ok, u.message);
    ok("THE CLIENT'S ASK ABOUT THE MOVED VIDEO WENT HOME WITH IT", (await prisma.revisionBrief.findUniqueOrThrow({ where: { id: askAboutMoved.id }, select: { projectId: true } })).projectId === DD.id);
    ok("…and the job-level ask stayed where it was raised", (await prisma.revisionBrief.findUniqueOrThrow({ where: { id: askAboutTheJob.id }, select: { projectId: true } })).projectId === CC.id);
    ok("no ask is on a different job from the video it is about", Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM "RevisionBrief" b JOIN "DeliverableOutput" o ON o.id = b."outputId" WHERE o."projectId" <> b."projectId"`,
    ))[0].n) === 0);
  }

  await nobodyOwesNothing("AND AT THE END OF ALL OF IT, no owed video is invisible to an editor");

  console.log(`\n${fail === 0 ? `ALL CHECKS PASSED (${pass} passed)` : `${fail} FAILED, ${pass} passed`}`);
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
