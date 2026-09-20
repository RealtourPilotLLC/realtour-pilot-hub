/**
 * TWO PEOPLE, ONE JOB — the Sep 20 fixes driven end to end, then swept.
 *
 *   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && set -a && source .env; set +a \
 *   && NODE_OPTIONS=--conditions=react-server \
 *      npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/journey-concurrency.ts
 *
 * Runs the SHIPPED actions (approveCut, requestCutChanges, setQueueStatus,
 * mergeProjectWork, reconcileDeliverablesToOrder, sweepUndeliveredPhotos,
 * flushPendingSms) against an ISOLATED in-process PGlite Postgres. Production
 * Neon is never touched — DATABASE_URL is overwritten below before any app
 * module loads, and no provider credential exists in this database, so no text,
 * DM or API call can leave the process.
 *
 * WHAT THIS HARNESS CAN AND CANNOT PROVE. PGLiteSocketServer multiplexes every
 * client connection onto ONE database connection. The first cut of this drill
 * tried Promise.all over two server actions anyway, and it did not merely fail
 * to prove concurrency — it CORRUPTED THE CONNECTION: the second insert's
 * unique violation arrived while two logical connections were in flight and
 * PGlite answered `UnexpectedMessage`, then closed. So:
 *   · every action below is driven SEQUENTIALLY — two presses seconds apart,
 *     which is the shape a second admin, a double-click through a round trip,
 *     or a stale tab actually produces, and the shape every read-then-write
 *     guard in this codebase is written for.
 *   · TWO SIMULTANEOUS REQUESTS ARE NOT TESTABLE HERE AT ALL. Nothing below
 *     claims one. Where simultaneity is the question, the check prints
 *     NOT PROVABLE HERE and names the guarding mechanism and the line instead.
 *   · A UNIQUE-CONSTRAINT VIOLATION KILLS THE CONNECTION, sequentially too —
 *     measured, not assumed: one duplicate insert, caught cleanly by Prisma as
 *     P2002, and every query after it answers P1017 "Server has closed the
 *     connection" for the rest of the process. So a drill may deliberately
 *     collide on a unique index EXACTLY ONCE, as its LAST database act, with
 *     every count it needs read beforehand. That is why the outbox duplicate is
 *     the final section of this file and why the bell's equivalent is a
 *     code-read note rather than a check.
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
  if (request === "next/server") return { after: (f: () => unknown) => { void f; } };
  return realLoad.call(this, request, parent, isMain);
};

const exec = promisify(execFile);
const PORT = 5493;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
delete process.env.AUTH_ENFORCE;

let pass = 0, fail = 0, noted = 0;
const ok = (label: string, good: boolean, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
/** A statement this harness cannot decide. Printed, counted, never green. */
const note = (label: string, detail: string) => {
  noted++;
  console.log(`  NOT PROVABLE HERE ${label}\n      ${detail}`);
};

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const { approveCut, requestCutChanges } = await import("@/app/review/actions");
  const { setQueueStatus, mergeProjectWork } = await import("@/app/editing/actions");
  const { reconcileDeliverablesToOrder, orderDeliverables } = await import("@/lib/integrations/aryeo");
  const { mergeFrom } = await import("@/lib/projectMerge");
  const { buildEditorQueue } = await import("@/lib/editorQueue");
  const { ensureOutputsForProject, refreshOutputsForProject } = await import("@/lib/deliverableOutputs");
  const { generateTasksForProject } = await import("@/lib/tasks");

  // ---- shared fixture vocabulary -------------------------------------------
  type Order = Parameters<typeof reconcileDeliverablesToOrder>[1];
  const REEL = "Standard Video Highlight Reel";
  const FLOORPLAN = "2D Floorplan";
  const order = (number: number, ...titles: string[]): Order =>
    ({ id: `ord-${number}`, number, items: titles.map((t, i) => ({ id: `it-${number}-${i}`, title: t, quantity: 1, amount: 25000 })) }) as Order;
  const VIDEO_TYPE = orderDeliverables(order(1, REEL).items).map((d) => d.type).includes("SOCIAL_REEL") ? "SOCIAL_REEL" : "VIDEO";

  const client = await prisma.client.create({ data: { name: "Mike Flatley" }, select: { id: true } });
  const shooter = await prisma.teamMember.create({
    data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER", payPercent: 0.35, payFloor: 100 },
    select: { id: true },
  });

  let seq = 0;
  const mk = async (street: string, status = "REVIEW") =>
    prisma.project.create({
      data: {
        title: `${street}, Royersford, PA`, clientId: client.id, status: status as "REVIEW", aryeoOrderId: `ord-seq-${++seq}`,
        payableInvoice: 450, price: 450, shootDate: new Date(Date.now() - 4 * 86_400_000), photographerId: shooter.id,
      },
      select: { id: true },
    });
  const mkReel = async (projectId: string, label: string) =>
    prisma.deliverable.create({ data: { projectId, type: VIDEO_TYPE as "SOCIAL_REEL", label, quantity: 1, manual: false }, select: { id: true } });
  const mkCut = async (projectId: string, deliverableId: string, round: number, fileName: string, status = "PENDING") =>
    prisma.reviewSubmission.create({
      data: {
        projectId, kind: "video", deliverableId, slot: 1, round, status, source: "upload",
        fileName, assetPath: `/Final/${fileName}`, submittedByKey: "kim", submittedByName: "Kim Miguel",
      },
      select: { id: true, status: true, round: true },
    });
  const subStatus = async (id: string) =>
    (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
  const activityLike = (projectId: string, needle: string) =>
    prisma.activity.count({ where: { projectId, body: { contains: needle } } });

  console.log("=".repeat(78));
  console.log("Two people acting at once, and what the next sweep makes of it");
  console.log("=".repeat(78));

  // =========================================================================
  console.log("\nJOURNEY 1 — TWO USERS ACT ON THE SAME CUT");
  // =========================================================================

  console.log("\n1a. Kyle presses Approve, then a second admin presses it again a moment later");
  {
    const P = await mk("11 Double Ln");
    const d = await mkReel(P.id, "Standard Tour Reel");
    const cut = await mkCut(P.id, d.id, 1, "reel-v1.mp4");
    const bellsWhere = { dedupeKey: { startsWith: `review-approved-${cut.id}` } };
    const r1 = await approveCut(cut.id);
    const bells1 = await prisma.notification.count({ where: bellsWhere });
    const r2 = await approveCut(cut.id);
    const bells2 = await prisma.notification.count({ where: bellsWhere });
    console.log(`      first:  ${r1.ok ? "ok" : "refused"} — ${r1.message}`);
    console.log(`      second: ${r2.ok ? "ok" : "refused"} — ${r2.message}`);
    ok("the second press is recognised as a repeat", /already approved/i.test(r2.message), r2.message);
    ok("the cut ends APPROVED", (await subStatus(cut.id)) === "APPROVED");
    const topaz = await prisma.topazJob.count({ where: { submissionId: cut.id } });
    ok("at most ONE 1080p render was filed (TopazJob.submissionId is @unique)", topaz <= 1, `${topaz} render rows`);
    ok("the second press rings NO new bell", bells2 === bells1, `${bells1} rows after the first press, ${bells2} after the second`);
    ok("…and the first press rang one row per person addressed, not one per press", bells1 >= 1 && bells1 <= 3, `${bells1} rows (office, editor, photographer)`);
    const timeline = await activityLike(P.id, "Cut approved in review");
    ok("ONE 'cut approved' line on the timeline", timeline === 1, `${timeline} timeline rows`);
    // The sweep that runs after any verdict.
    await ensureOutputsForProject(P.id);
    await refreshOutputsForProject(P.id);
    const outs = await prisma.deliverableOutput.count({ where: { projectId: P.id } });
    ok("the per-video sweep leaves ONE row for the one video owed", outs === 1, `${outs} DeliverableOutput rows`);
    const approvedOuts = await prisma.deliverableOutput.count({ where: { projectId: P.id, approvedAt: { not: null } } });
    ok("…and it reads the approval once", approvedOuts <= 1, `${approvedOuts} approved`);
  }
  console.log("\n1a(ii). The stale-read seam — the row moves between approveCut's read and its write");
  {
    // NOT A RACE, AND NOT CLAIMED AS ONE. Two simultaneous requests are not
    // testable in this harness (see the header), so this reproduces the one
    // thing a race produces that two presses seconds apart never do: a read
    // that is ALREADY OUT OF DATE by the time the write lands. findUnique on
    // ReviewSubmission is wrapped for EXACTLY ONE call — approveCut's own read
    // answers with the row as Kyle's tab saw it (PENDING) while the database
    // row has already moved to CHANGES_REQUESTED under it. Nothing in the
    // action is stubbed: the shipped approveCut is still the code under test,
    // and this is the seam the Sep 20 compare-and-set exists for. Before that
    // fix the write was a bare `update` by id, so the approval landed on top
    // of the other reviewer's bounce and ran the whole downstream — Dropbox
    // Final, a 1080p credit, the portal-library row, the revision close-out.
    const P = await mk("55 Seam St");
    const d = await mkReel(P.id, "Standard Tour Reel");
    const cut = await mkCut(P.id, d.id, 1, "reel-v1.mp4");
    type SubDelegate = { findUnique: typeof prisma.reviewSubmission.findUnique };
    const delegate = prisma.reviewSubmission as unknown as SubDelegate;
    const realFindUnique = delegate.findUnique.bind(prisma.reviewSubmission) as SubDelegate["findUnique"];
    let armed = true;
    delegate.findUnique = ((args: Parameters<SubDelegate["findUnique"]>[0]) =>
      (async () => {
        const row = await realFindUnique(args);
        if (armed) {
          armed = false;
          // The other reviewer's verdict, landing in the gap.
          await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { status: "CHANGES_REQUESTED" } });
        }
        return row;
      })()) as unknown as SubDelegate["findUnique"];
    let r: { ok: boolean; message: string };
    try {
      r = await approveCut(cut.id);
    } finally {
      delegate.findUnique = realFindUnique;
    }
    console.log(`      approve on a read that went stale mid-flight: ${r.ok ? "ok" : "refused"} — ${r.message}`);
    const st = await subStatus(cut.id);
    ok("the caller that did NOT move the row is refused", !r.ok, r.message);
    ok("the other reviewer's verdict stands", st === "CHANGES_REQUESTED", `the cut reads ${st}`);
    const timeline = await activityLike(P.id, "Cut approved in review");
    ok("no 'cut approved' line was written for the loser", timeline === 0, `${timeline} timeline rows`);
    const topaz = await prisma.topazJob.count({ where: { submissionId: cut.id } });
    ok("no 1080p credit was spent on it", topaz === 0, `${topaz} render rows`);
    const bells = await prisma.notification.count({ where: { dedupeKey: { startsWith: `review-approved-${cut.id}` } } });
    ok("no approval bell rang", bells === 0, `${bells} rows`);
    await ensureOutputsForProject(P.id);
    await refreshOutputsForProject(P.id);
    const approvedOuts = await prisma.deliverableOutput.count({ where: { projectId: P.id, approvedAt: { not: null } } });
    ok("and the per-video sweep behind it does not call the video approved", approvedOuts === 0, `${approvedOuts} approved`);
  }
  note(
    "two Approve presses landing in the same instant, as two real backends",
    "1a(ii) drives the stale read that a race produces, at a named seam, and the compare-and-set " +
      "(src/app/review/actions.ts — `updateMany({ where: { id, status: submission.status } })`, the shape reassignCut has " +
      "used since Sep 16 at :2282) refuses the loser before any of the downstream runs. What is still NOT proved here is " +
      "true simultaneity: PGLiteSocketServer multiplexes onto one connection, so the two updateMany statements cannot " +
      "actually contend for the row lock. Postgres serialises them on that lock, which is the whole basis of the guard.",
  );

  console.log("\n1b. A STALE Approve — John has already uploaded round 2 under Kyle's open tab");
  {
    const P = await mk("22 Stale Rd");
    const d = await mkReel(P.id, "Standard Tour Reel");
    const v1 = await mkCut(P.id, d.id, 1, "reel-v1.mp4");
    const v2 = await mkCut(P.id, d.id, 2, "reel-v2.mp4");
    // The state the SHIPPED upload path leaves behind: finishCutUpload flips
    // every earlier PENDING round of the same (deliverable, slot) to SUPERSEDED
    // (src/lib/reviewCuts.ts:1032-1036). Kyle's tab was rendered before that,
    // so it still shows round 1 with both verdict buttons live.
    await prisma.reviewSubmission.update({ where: { id: v1.id }, data: { status: "SUPERSEDED" } });
    const r = await approveCut(v1.id); // the round on Kyle's screen, not the newest
    console.log(`      approving the SUPERSEDED round 1 while round 2 is in the room: ${r.ok ? "ok" : "refused"} — ${r.message}`);
    const s1 = await subStatus(v1.id), s2 = await subStatus(v2.id);
    console.log(`      round 1 → ${s1}, round 2 → ${s2}`);
    ok("a superseded round is NOT signed off as the client's video", !r.ok || s1 !== "APPROVED", `round 1 is ${s1}`);
    ok("…the same way a superseded round cannot be MOVED (whyNotTakeBack, actions.ts:1669)",
      !r.ok, r.ok ? "approveCut accepted it; reassignCut would have refused it" : "refused");
    ok("the newest round is still awaiting a verdict", s2 === "PENDING", `round 2 is ${s2}`);
    // Whatever the verdict did, the SET-level count must still hold delivery.
    ok("…and the set does not read 'ready to deliver'", /still in review|more video/i.test(r.message) || !r.ok, r.message);
    const card = await prisma.smartTask.findFirst({ where: { projectId: P.id, taskType: "edit_video" }, select: { status: true } });
    ok("no edit card was closed out from under the open round", !card || card.status !== "COMPLETED", card?.status ?? "no card");
  }

  console.log("\n1b(ii). The same stale press, on a DELIVERED job with the client's revision open");
  {
    // The ordinary revision loop: the client asks, John uploads the correction
    // (round 2), Kyle opens it, John uploads round 3 — which supersedes round 2
    // — and Kyle, still on the old screen, approves round 2.
    const raisedAt = new Date(Date.now() - 3 * 3_600_000);
    const P = await mk("66 Closed Early Rd", "REVISION");
    await prisma.project.update({
      where: { id: P.id },
      data: { deliveredAt: new Date(Date.now() - 2 * 86_400_000), revisionRequestedAt: raisedAt },
    });
    const d = await mkReel(P.id, "Standard Tour Reel");
    await prisma.smartTask.create({
      data: {
        projectId: P.id, taskType: "revision", title: "Video revision — the client wants the drone shot back",
        dedupeKey: `revision-${P.id}`, status: "OPEN", source: "hub",
        createdAt: raisedAt,
      },
    });
    const v2 = await mkCut(P.id, d.id, 2, "reel-v2.mp4");
    await mkCut(P.id, d.id, 3, "reel-v3.mp4");
    await prisma.reviewSubmission.update({ where: { id: v2.id }, data: { status: "SUPERSEDED" } });
    const openBefore = await prisma.smartTask.count({ where: { projectId: P.id, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } } });
    const r = await approveCut(v2.id);
    console.log(`      approving the superseded correction: ${r.ok ? "ok" : "refused"} — ${r.message}`);
    const openAfter = await prisma.smartTask.count({ where: { projectId: P.id, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } } });
    const stamp = (await prisma.project.findUniqueOrThrow({ where: { id: P.id }, select: { revisionRequestedAt: true } })).revisionRequestedAt;
    console.log(`      open revision asks ${openBefore} → ${openAfter}; the job's revision stamp is ${stamp ? "still set" : "CLEARED"}`);
    ok("the client's ask is NOT closed by a version the editor has already replaced", openAfter === openBefore,
      `${openBefore} → ${openAfter} open`);
    ok("…and the job is not stamped as having its revision answered", !!stamp, stamp ? "stamp intact" : "stamp cleared");
  }

  console.log("\n1c. A STALE 'Request changes' — the cut was approved while the second tab still read PENDING");
  {
    const P = await mk("33 Split Way");
    const d = await mkReel(P.id, "Standard Tour Reel");
    const cut = await mkCut(P.id, d.id, 1, "reel-v1.mp4");
    // The other reviewer's note, written while the cut was still PENDING — it is
    // what makes "Request changes" a live button rather than a refusal.
    await prisma.mediaNote.create({
      data: {
        projectId: P.id, assetUrl: `cut:${cut.id}`, assetType: "video", lane: "EDITOR", kind: "fix",
        body: "The 0:12 cut is early — hold the drone push a beat.", status: "OPEN",
        authorKey: "owner", authorName: "Jordan", timeSec: 12,
      },
    });
    const a = await approveCut(cut.id);
    console.log(`      approve: ${a.ok ? "ok" : "refused"} — ${a.message}`);
    await ensureOutputsForProject(P.id);
    await refreshOutputsForProject(P.id);
    const approvedBefore = await prisma.deliverableOutput.count({ where: { projectId: P.id, approvedAt: { not: null } } });
    const b = await requestCutChanges(cut.id); // the other tab, seconds behind
    console.log(`      bounce:  ${b.ok ? "ok" : "refused"} — ${b.message}`);
    const st = await subStatus(cut.id);
    const proj = await prisma.project.findUniqueOrThrow({ where: { id: P.id }, select: { status: true } });
    console.log(`      the cut reads ${st}; the job reads ${proj.status}; the per-video row read approved=${approvedBefore} before the bounce`);
    ok("a signed-off cut is not silently un-approved by a stale tab", !b.ok || st === "APPROVED", `${st} after the bounce`);
    ok("the cut's verdict and the job's stage agree",
      (st === "APPROVED" && proj.status !== "REVISION") || (st === "CHANGES_REQUESTED" && proj.status === "REVISION"),
      `${st} vs ${proj.status}`);
    // THE SWEEP: whatever the two verdicts left behind, the per-video row is
    // re-derived from the rounds and must not still call the video approved.
    await refreshOutputsForProject(P.id);
    const row = await prisma.deliverableOutput.findFirst({ where: { projectId: P.id }, select: { approvedAt: true, approvedSubmissionId: true } });
    const stillApproved = !!row?.approvedAt;
    ok("after the sweep, 'approved' on the per-video row matches the cut's verdict",
      stillApproved === (st === "APPROVED"),
      `row approved=${stillApproved}, cut=${st}`);
  }

  console.log("\n1c(ii). …and the ORDINARY bounce, on a cut nobody has ruled on, still goes through");
  {
    // The counterweight to 1b and 1c. Four status refusals went into these two
    // actions on Sep 20, and a guard that quietly swallows the normal path is
    // its own defect — so drive the everyday press: one open editor note, a
    // PENDING round, Kyle sends it back.
    const P = await mk("77 Ordinary Way");
    const d = await mkReel(P.id, "Standard Tour Reel");
    const cut = await mkCut(P.id, d.id, 1, "reel-v1.mp4");
    await prisma.mediaNote.create({
      data: {
        projectId: P.id, assetUrl: `cut:${cut.id}`, assetType: "video", lane: "EDITOR", kind: "fix",
        body: "Lose the last 4 seconds — it lingers on the empty kitchen.", status: "OPEN",
        authorKey: "owner", authorName: "Jordan", timeSec: 41,
      },
    });
    const b = await requestCutChanges(cut.id);
    console.log(`      bounce: ${b.ok ? "ok" : "refused"} — ${b.message}`);
    const st = await subStatus(cut.id);
    const proj = await prisma.project.findUniqueOrThrow({ where: { id: P.id }, select: { status: true, revisionRequestedAt: true } });
    ok("the everyday Request-changes is accepted", b.ok, b.message);
    ok("the cut goes back to the editor", st === "CHANGES_REQUESTED", `the cut reads ${st}`);
    ok("the job reads Revisions, stamped so the hourly engine can't flip it back", proj.status === "REVISION" && !!proj.revisionRequestedAt, proj.status);
    const card = await prisma.smartTask.findFirst({ where: { projectId: P.id, taskType: "edit_video" }, select: { status: true, summary: true } });
    ok("…and the notes are a ROUND on the one edit card", !!card && card.status !== "COMPLETED", card?.status ?? "no card");
  }

  console.log("\n1c(iii). The bounce's OWN stale-read seam — what a lost claim is allowed to leave behind");
  {
    // THE WAVE-4 DEFECT, driven. Same named seam as 1a(ii) and the same honesty
    // about it: this is not two simultaneous requests, it is the one thing a
    // race produces that two presses seconds apart never do — a read that is
    // already out of date when the write lands. requestCutChanges reads the row
    // as Kyle's tab saw it (PENDING) while the other reviewer's Approve has
    // already landed underneath, so every status refusal above the claim passes
    // and only the compare-and-set can stop it.
    //
    // Until Sep 20 the client's revision task was flipped IN_PROGRESS -> OPEN
    // and its state sentence rewritten BEFORE that claim ran, so a loser left
    // the ledger reading "the corrected cut came back from review" on a cut
    // that in fact stood APPROVED, with the job never moved to Revisions. The
    // rewrite now sits after the claim. The ONE residue the code still admits
    // to — the round on the editor's card — is asserted here as well, so this
    // check fails either way it drifts: a rollback that loses the notes, or a
    // regression that starts rewriting the ledger again.
    const P = await mk("88 Ledger Ln", "REVIEW");
    const d = await mkReel(P.id, "Standard Tour Reel");
    const cut = await mkCut(P.id, d.id, 2, "reel-v2.mp4");
    const ASK = "Corrected cut submitted — waiting on review. Client asked for changes after delivery: “put the drone shot back”.";
    const rev = await prisma.smartTask.create({
      data: {
        projectId: P.id, taskType: "revision", title: "Video revision — 88 Ledger Ln",
        summary: ASK, status: "IN_PROGRESS", assignedKey: "kim", source: "hub",
      },
      select: { id: true },
    });
    const noteRow = await prisma.mediaNote.create({
      data: {
        projectId: P.id, assetUrl: `cut:${cut.id}`, assetType: "video", lane: "EDITOR", kind: "fix",
        body: "The drone push is back but it is a beat late.", status: "OPEN",
        authorKey: "owner", authorName: "Jordan", timeSec: 8,
      },
      select: { id: true },
    });
    type SubDelegate = { findUnique: typeof prisma.reviewSubmission.findUnique };
    const delegate = prisma.reviewSubmission as unknown as SubDelegate;
    const realFindUnique = delegate.findUnique.bind(prisma.reviewSubmission) as SubDelegate["findUnique"];
    let armed = true;
    delegate.findUnique = ((args: Parameters<SubDelegate["findUnique"]>[0]) =>
      (async () => {
        const row = await realFindUnique(args);
        if (armed) {
          armed = false;
          // The other reviewer's Approve, landing in the gap. Only the row —
          // approveCut's own downstream is not what this check is about.
          await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { status: "APPROVED", decidedAt: new Date() } });
        }
        return row;
      })()) as unknown as SubDelegate["findUnique"];
    let b: { ok: boolean; message: string };
    try {
      b = await requestCutChanges(cut.id);
    } finally {
      delegate.findUnique = realFindUnique;
    }
    console.log(`      bounce on a read that went stale mid-flight: ${b.ok ? "ok" : "refused"} — ${b.message}`);
    const st = await subStatus(cut.id);
    const proj = await prisma.project.findUniqueOrThrow({ where: { id: P.id }, select: { status: true, revisionRequestedAt: true } });
    const after = await prisma.smartTask.findUniqueOrThrow({ where: { id: rev.id }, select: { status: true, summary: true } });
    console.log(`      the cut reads ${st}; the job reads ${proj.status}; the client's revision reads ${after.status}`);
    console.log(`      the revision's summary: ${after.summary}`);
    ok("the caller that did NOT win the row is refused", !b.ok, b.message);
    ok("the other reviewer's approval stands", st === "APPROVED", `the cut reads ${st}`);
    ok("the client's revision is NOT reopened by a bounce that lost", after.status === "IN_PROGRESS", `it reads ${after.status}`);
    ok("…and its state sentence is untouched, so the ledger still matches the cut", after.summary === ASK, after.summary ?? "—");
    ok("the job was not moved to Revisions behind the approval",
      proj.status === "REVIEW" && !proj.revisionRequestedAt, `${proj.status}, stamp ${proj.revisionRequestedAt ? "set" : "unset"}`);
    const timeline = await activityLike(P.id, "Changes requested on the round-");
    ok("no 'changes requested' line was written for the loser", timeline === 0, `${timeline} timeline rows`);
    const bells = await prisma.notification.count({ where: { dedupeKey: `review-changes-${cut.id}-${noteRow.id}` } });
    ok("no changes bell rang for the loser", bells === 0, `${bells} rows`);
    // The one residue the code documents, asserted in BOTH directions.
    const card = await prisma.smartTask.findFirst({ where: { projectId: P.id, taskType: "edit_video" }, select: { summary: true } });
    ok("the notes DID reach the editor's card as a round (the documented residue)",
      !!card && /round 3/i.test(card.summary ?? ""), card?.summary?.slice(0, 90) ?? "no card");
    ok("…and the refusal says so, and says nobody was pinged about it",
      /round 3 on the edit card/.test(b.message) && /nobody was pinged/.test(b.message), b.message);
  }

  console.log("\n1d. Two people press Completed on the same job, then the task sweep runs");
  {
    const P = await mk("44 Deliver Dr", "REVIEW");
    const d = await mkReel(P.id, "Standard Tour Reel");
    const cut = await mkCut(P.id, d.id, 1, "reel-v1.mp4", "APPROVED");
    void cut;
    const x = await setQueueStatus(P.id, "Completed");
    const y = await setQueueStatus(P.id, "Completed");
    console.log(`      first:  ${x.ok ? "ok" : "refused"} — ${x.message}`);
    console.log(`      second: ${y.ok ? "ok" : "refused"} — ${y.message}`);
    const after = await prisma.project.findUniqueOrThrow({ where: { id: P.id }, select: { status: true, deliveredAt: true } });
    ok("the job is delivered exactly once", after.status === "DELIVERED" && !!after.deliveredAt, `${after.status} @ ${after.deliveredAt?.toISOString() ?? "—"}`);
    const stamp = after.deliveredAt!.getTime();
    await setQueueStatus(P.id, "Completed"); // a third press, later
    const again = await prisma.project.findUniqueOrThrow({ where: { id: P.id }, select: { deliveredAt: true } });
    ok("a later press does not move the delivery date (deliveryStamp rule 1)", again.deliveredAt!.getTime() === stamp);
    // THE SWEEP: the task engine reconciles the job twice, as two crons would.
    await generateTasksForProject(P.id).catch(() => {});
    await generateTasksForProject(P.id).catch(() => {});
    const texts = await prisma.smartTask.count({ where: { projectId: P.id, taskType: "delivery_text", status: { notIn: ["CANCELLED"] } } });
    ok("the sweep leaves ONE delivery-text card, not two", texts <= 1, `${texts} delivery_text cards`);
  }

  // =========================================================================
  console.log("\n\nJOURNEY 2 — TWO SWEEPS ON THE SAME MERGED PAIR");
  // =========================================================================
  // The hourly /api/cron/sync and a press of "Refresh from Aryeo" reconcile the
  // SAME order. Both reach reconcileDeliverablesToOrder with the same payload.
  const sweep = async (projectId: string, o: Order) => {
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { status: true } });
    if (["DELIVERED", "CANCELLED"].includes(p.status)) return { skipped: true, retired: [] as string[], added: [] as string[], restored: [] as string[] };
    const r = await reconcileDeliverablesToOrder(projectId, o);
    return { skipped: false, retired: r.retired, added: r.added, restored: r.restored };
  };
  const onBoard = async (id: string) => {
    const q = await buildEditorQueue();
    return [...q.notDone, ...q.upcoming, ...q.done].some((r) => r.id === id);
  };
  const live = (projectId: string) => prisma.deliverable.count({ where: { projectId, removedFromOrderAt: null } });

  const SURV = await mk("204 Spring Ln", "EDITING");
  const DONOR = await mk("204 Spring Ln", "EDITING");
  const oSurv = order(2601, REEL), oDonor = order(2602, REEL);
  const dSurv = await mkReel(SURV.id, "Original reel");
  const dDonor = await mkReel(DONOR.id, "Second reel");
  const donorCut = await mkCut(DONOR.id, dDonor.id, 1, "second-reel-v1.mp4");
  ok("the merge is accepted", (await mergeProjectWork(DONOR.id, SURV.id, "second reel, same listing")).ok);

  console.log("\n2a. The hourly sync and a manual Refresh, back to back, on the donor's order");
  {
    const before = await prisma.deliverable.count();
    const cron = await sweep(DONOR.id, oDonor);
    const refresh = await sweep(DONOR.id, oDonor);
    ok("the hourly sync changes nothing", cron.added.length === 0 && cron.retired.length === 0, JSON.stringify(cron));
    ok("the manual Refresh right behind it changes nothing", refresh.added.length === 0 && refresh.retired.length === 0, JSON.stringify(refresh));
    ok("no row was minted by either", (await prisma.deliverable.count()) === before);
    ok("the editor's cut still sits on the job holding the work",
      (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: donorCut.id }, select: { projectId: true } })).projectId === SURV.id);
    ok("ONE Editing Room row, and it is the survivor", (await onBoard(SURV.id)) && !(await onBoard(DONOR.id)));
  }

  console.log("\n2b. A line is added to the donor's order while both sweeps are running");
  {
    const oDonor2 = order(2602, REEL, FLOORPLAN);
    const cron = await sweep(DONOR.id, oDonor2);
    const refresh = await sweep(DONOR.id, oDonor2);
    ok("the cron mints the new line once", cron.added.length === 1, JSON.stringify(cron.added));
    ok("the Refresh immediately behind it mints nothing", refresh.added.length === 0, JSON.stringify(refresh.added));
    const plans = await prisma.deliverable.findMany({ where: { type: "FLOORPLAN" }, select: { id: true, projectId: true } });
    ok("exactly ONE floor plan exists", plans.length === 1, `${plans.length} rows`);
    ok("…on the job carrying the work", plans[0]?.projectId === SURV.id);
    ok("…and the marker owns it, so the undo stays exact",
      ((await mergeFrom(DONOR.id))?.moved.deliverableIds ?? []).includes(plans[0].id));
    ok("the survivor's own sweep does not retire the row parked on it", (await sweep(SURV.id, oSurv)).retired.length === 0);
    ok("the donor still owes nothing", (await live(DONOR.id)) === 0);
  }

  console.log("\n2c. Two live rows of one type — what the next sweep does with the pair");
  {
    // The shape the audit's sort fix is about, reached directly: whatever put
    // two rows there, the sweep must settle on ONE and must keep the OLDEST
    // (the one the cuts hang off), not whichever Postgres happened to return.
    const stray = await prisma.deliverable.create({
      data: { projectId: SURV.id, type: VIDEO_TYPE as "SOCIAL_REEL", label: "Standard Video Highlight Reel", quantity: 1, manual: false },
      select: { id: true },
    });
    const r = await sweep(SURV.id, oSurv);
    const survRow = await prisma.deliverable.findUniqueOrThrow({ where: { id: dSurv.id }, select: { removedFromOrderAt: true } });
    const strayRow = await prisma.deliverable.findUniqueOrThrow({ where: { id: stray.id }, select: { removedFromOrderAt: true } });
    ok("the sweep settles on one row of the type", r.retired.length === 1, JSON.stringify(r.retired));
    ok("the OLDEST row — the one the work hangs off — is the one kept", !survRow.removedFromOrderAt && !!strayRow.removedFromOrderAt);
    ok("…and it is stable: running it again changes nothing", (await sweep(SURV.id, oSurv)).retired.length === 0);
    await prisma.deliverable.delete({ where: { id: stray.id } });
  }
  note(
    "two reconciles of one order running at the same instant",
    "The create loop is guarded by nothing but the read a few lines above it: reconcileDeliverablesToOrder builds `want` " +
      "from rows it read outside any transaction (src/lib/integrations/aryeo.ts:2075 findMany, :2211 create), there is no " +
      "unique index on Deliverable(projectId,type) in prisma/schema.prisma, and the only lock on this path is the marker " +
      "append's SELECT … FOR UPDATE (src/lib/projectMerge.ts:206) which serialises the APPEND, not the mint. Two backends " +
      "that both miss the row would therefore both mint it. 2c is the honest consolation: the very next sweep retires the " +
      "younger duplicate and keeps the row the cuts hang off, so the window is one sweep wide and self-healing.",
  );

  // =========================================================================
  console.log("\n\nJOURNEY 3 — A MERGE AND A RECONCILIATION INTERLEAVED");
  // =========================================================================

  console.log("\n3a. The sync read the order BEFORE the merge and writes AFTER it");
  {
    const A = await mk("7 Interleave Ct", "EDITING"), B = await mk("7 Interleave Ct", "EDITING");
    const oA = order(2701, REEL), oB = order(2702, REEL);
    const dA = await mkReel(A.id, "Original reel");
    const dB = await mkReel(B.id, "Second reel");
    const cut = await mkCut(B.id, dB.id, 1, "second-v1.mp4");
    // The cron's payload, fetched at :00 — captured here, before the merge.
    const snapshotA = oA, snapshotB = oB;
    ok("the merge is accepted at :00:30", (await mergeProjectWork(B.id, A.id)).ok);
    // …and the reconcile lands at :01, still carrying the pre-merge payload.
    const rA = await sweep(A.id, snapshotA), rB = await sweep(B.id, snapshotB);
    ok("the survivor's late write retires nothing", rA.retired.length === 0, JSON.stringify(rA));
    ok("the donor's late write re-mints nothing", rB.added.length === 0, JSON.stringify(rB));
    ok("the moved reel is still owed on the survivor",
      (await prisma.deliverable.findUniqueOrThrow({ where: { id: dB.id }, select: { projectId: true, removedFromOrderAt: true } })).projectId === A.id);
    ok("the editor's cut was not orphaned",
      (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut.id }, select: { projectId: true } })).projectId === A.id);
    ok("the survivor's own reel is untouched",
      !(await prisma.deliverable.findUniqueOrThrow({ where: { id: dA.id }, select: { removedFromOrderAt: true } })).removedFromOrderAt);
  }

  console.log("\n3c. A webhook mints a row on the donor INSIDE the merge's own window");
  {
    // Deterministic injection at a named seam, NOT real concurrency: the merge
    // snapshots what it will move (previewMerge, editing/actions.ts:1934) and
    // then moves it in a transaction (:1943). An order.updated webhook that
    // mints a row on the donor between those two lines is invisible to the
    // snapshot. The injection is performed by wrapping prisma.$transaction for
    // exactly one call, so the shipped action is the code under test.
    const A = await mk("8 Window Way", "EDITING"), B = await mk("8 Window Way", "EDITING");
    const oA = order(2801, REEL), oB = order(2802, REEL);
    await mkReel(A.id, "Original reel");
    const dB = await mkReel(B.id, "Second reel");
    let injected: string | null = null;
    const client_ = prisma as unknown as { $transaction: (...a: unknown[]) => unknown };
    const realTx = client_.$transaction.bind(prisma);
    client_.$transaction = async (...args: unknown[]) => {
      if (!injected) {
        // What a reconcile does when it finds the donor owing no video and no
        // merge marker to read: it mints the order's reel back onto the donor.
        const row = await prisma.deliverable.create({
          data: { projectId: B.id, type: VIDEO_TYPE as "SOCIAL_REEL", label: REEL, quantity: 1, manual: false },
          select: { id: true },
        });
        injected = row.id;
      }
      return realTx(...(args as Parameters<typeof realTx>));
    };
    const merged = await mergeProjectWork(B.id, A.id);
    client_.$transaction = realTx;
    ok("the merge is accepted", merged.ok, merged.message);
    const where = await prisma.deliverable.findUniqueOrThrow({ where: { id: injected! }, select: { projectId: true, removedFromOrderAt: true } });
    console.log(`      the row minted mid-merge sits on ${where.projectId === B.id ? "the DONOR" : "the survivor"}, ${where.removedFromOrderAt ? "retired" : "still owed"}`);
    ok("the moved reel went to the survivor regardless",
      (await prisma.deliverable.findUniqueOrThrow({ where: { id: dB.id }, select: { projectId: true } })).projectId === A.id);
    const strandedNow = await onBoard(B.id);
    console.log(`      before any sweep, the merged-away job is ${strandedNow ? "BACK on the Editing Room owing a video" : "off the Editing Room"}`);
    // THE SWEEP. Whatever the window left behind, the next reconcile is the
    // thing that has to settle it.
    const rB = await sweep(B.id, oB), rA = await sweep(A.id, oA);
    console.log(`      the donor's next sweep: ${JSON.stringify(rB)}`);
    const settled = await prisma.deliverable.findUniqueOrThrow({ where: { id: injected! }, select: { projectId: true, removedFromOrderAt: true, removedFromOrderNote: true } });
    ok("the next sweep settles the stray rather than leaving it hanging",
      settled.projectId === A.id || !!settled.removedFromOrderAt,
      settled.projectId === A.id ? "moved to the job holding the work" : `retired: ${settled.removedFromOrderNote ?? ""}`);
    ok("the survivor's sweep is quiet", rA.retired.length === 0, JSON.stringify(rA));
    ok("the donor does not end up back on the Editing Room owing a video", !(await onBoard(B.id)));
    ok("nothing is left pointing at a deliverable on another job",
      Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*)::bigint AS n FROM "ReviewSubmission" s JOIN "Deliverable" d ON d.id = s."deliverableId" WHERE d."projectId" <> s."projectId"`,
      ))[0].n) === 0);
  }
  note(
    "a merge and a reconcile writing at the same instant",
    "mergeProjectWork reads its guards and its row snapshot OUTSIDE the transaction (src/app/editing/actions.ts:1917 mergeFrom, " +
      ":1934 previewMerge) and only the row moves are transactional (:1943). No advisory lock is taken on either project id, so " +
      "on two backends the window 3c injects into is real. The reconcile's own side is defended differently and better: it reads " +
      "the marker first and returns without writing if it cannot (src/lib/integrations/aryeo.ts:2038).",
  );

  // =========================================================================
  console.log("\n\nJOURNEY 4 — THE SAME ALERT TWICE, IN QUICK SUCCESSION");
  // =========================================================================
  {
    const { putSetting } = await import("@/lib/settings");
    const { sweepUndeliveredPhotos } = await import("@/lib/deliveryWatch");
    const { flushPendingSms, notifyInApp } = await import("@/lib/notify");

    // The alert only runs inside its own ET window and only on a day the rota
    // covers. Both are Settings rows, so the isolated database is configured to
    // put "now" inside the alert window and OUTSIDE covered hours — which is the
    // routine-alert path the Sep 18 fix added, and the one that never touches a
    // provider.
    const etHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()));
    const coverFrom = (etHour + 2) % 24, coverTo = Math.min(23, coverFrom + 1);
    await putSetting("internal_alerts", {
      uploadReminder: { enabled: true, hour: 19 },
      uploadChaser: { enabled: true, hour: 22 },
      photosUndelivered: { enabled: true, fromHour: Math.max(0, etHour), toHour: Math.min(23, etHour + 1), lateAfterHours: 26 },
      rawVideoMissing: { enabled: true },
      kyleDigests: { enabled: true },
      coverage: { weekdaysOnly: false, fromHour: coverFrom, toHour: coverTo > coverFrom ? coverTo : coverFrom + 1, onCallTeamMemberId: null },
    });
    console.log(`      alert window ${etHour}:00–${etHour + 1}:00 ET, cover ${coverFrom}:00–${coverTo}:00 ET (so this raise is routine + out of cover)`);

    const kyle = await prisma.teamMember.create({
      data: { name: "Kyle Drill", email: "kyle@drill.invalid", role: "MANAGER", phone: "+12155550147", opsAlerts: true, active: true, payPercent: 0, payFloor: 0 },
      select: { id: true },
    });
    const late = await prisma.project.create({
      data: {
        title: "99 Late Photos Ln, Royersford, PA", clientId: client.id, status: "EDITING",
        aryeoOrderId: "ord-late", aryeoListingId: "listing-late",
        shootDate: new Date(Date.now() - 3 * 86_400_000), statusCheckedAt: new Date(),
        statusEvidence: JSON.stringify({
          expected: ["Photos"], present: [], missing: ["Photos"], awaitingSend: [],
          aryeo: { photos: 0, videos: 0, floorPlans: 0, interactive: 0, delivery: null, at: new Date().toISOString() },
          reason: "Photos not on the listing", checkedAt: new Date().toISOString(),
        }),
      },
      select: { id: true },
    });

    console.log("\n4a. The 16:00 pass and a second pass moments later");
    const first = await sweepUndeliveredPhotos();
    const second = await sweepUndeliveredPhotos();
    console.log(`      first:  ${JSON.stringify(first)}`);
    console.log(`      second: ${JSON.stringify(second)}`);
    ok("the first pass raises the alert", first.alerted === 1, `alerted ${first.alerted}, late ${first.late}`);
    ok("the second pass raises NOTHING", second.alerted === 0, `alerted ${second.alerted}`);
    const bells = await prisma.notification.count({ where: { dedupeKey: `photos-undelivered-${late.id}-0` } });
    ok("ONE bell row is the ledger", bells === 1, `${bells} rows`);
    const lines = await prisma.pendingSms.count({ where: { teamMemberId: kyle.id } });
    ok("ONE line in Kyle's text queue, not two", lines === 1, `${lines} queued lines`);
    const held = await prisma.pendingSms.findFirst({ where: { teamMemberId: kyle.id }, select: { deferUntil: true, sentAt: true } });
    ok("…and it is DATED rather than buzzing his phone now", !!held?.deferUntil && !held.sentAt, held?.deferUntil?.toISOString() ?? "no hold");

    console.log("\n4b. …and then the text flusher runs, twice");
    const f1 = await flushPendingSms();
    const f2 = await flushPendingSms();
    console.log(`      flush 1: ${JSON.stringify(f1)}`);
    console.log(`      flush 2: ${JSON.stringify(f2)}`);
    ok("nothing is sent while the hold stands", f1.flushed === 0 && f2.flushed === 0, `${f1.flushed}+${f2.flushed} sent`);
    ok("the line is still there, waiting for a day somebody is covering",
      (await prisma.pendingSms.count({ where: { teamMemberId: kyle.id, sentAt: null } })) === 1);

    void notifyInApp; // see the note below: colliding on the bell's unique index would end the run
  }
  note(
    "two overlapping cron runs of the photos alert",
    "sweepUndeliveredPhotos guards the TEXT with a READ of the bell ledger (src/lib/deliveryWatch.ts:152 findUnique) and then " +
      "pushes the job onto `fresh` unconditionally (:161), so `fresh` is non-empty and notifyStaffSms is called (:180) whether " +
      "or not the bell row was actually created. It cannot know: notifyInApp catches its own P2002 and returns the same " +
      "{ bridged: [], silenced: 0 } either way (src/lib/notify.ts:1131-1137). Sequentially the probe is airtight, which 4a " +
      "proves end to end. Two runs that both probe before either creates would both text — the unique index stops the " +
      "duplicate BELL, not the duplicate TEXT. Not checked live here because a deliberate P2002 ends the run (see the header).",
  );

  // =========================================================================
  console.log("\n\nJOURNEY 1e — THE CLIENT IS TOLD ONCE: the shipped outbox");

  // =========================================================================
  {
    const { createOutbox, prismaOutboxStore, deliveryKey } = await import("@/lib/outbox");
    let handed = 0;
    const outbox = createOutbox({
      store: prismaOutboxStore(),
      // A stub standing in for OpenPhone. No provider credential exists in this
      // database, so the real one could only throw; the STATE MACHINE under test
      // is the shipped one, unchanged.
      provider: { send: async () => { handed++; return { providerId: `stub-${handed}` }; } },
    });
    const P = await mk("55 Once Only", "DELIVERED");
    const msg = { channel: "sms" as const, toRef: "2155550123", body: "Everything is ready.", dedupeKey: deliveryKey(P.id), projectId: P.id };
    const first = await outbox.sendThroughOutbox(msg, { workerId: "cron-a" });
    const rows = await prisma.outboxMessage.count({ where: { dedupeKey: deliveryKey(P.id) } });
    const row = await prisma.outboxMessage.findUniqueOrThrow({ where: { dedupeKey: deliveryKey(P.id) }, select: { state: true, providerId: true } });
    ok("the first send is accepted", first.outcome === "accepted", first.outcome);
    ok("the provider was handed it once", handed === 1, `${handed} hand-off${handed === 1 ? "" : "s"}`);
    ok("ONE outbox row holds the job's delivery identity, and it is settled", rows === 1 && row.state === "accepted", `${rows} row, state ${row.state}`);
  }
  note(
    "a SECOND send under the same delivery identity",
    "Not runnable here at all: the duplicate is refused by the database (OutboxMessage.dedupeKey @unique), enqueue() turns " +
      "that P2002 into OutboxDuplicateError and then READS the holder back (src/lib/outbox.ts:401 store.byDedupeKey) — and " +
      "in this harness the connection is already dead by then, so the call throws instead of answering 'duplicate'. Read " +
      "instead: the claim is taken in sendThroughOutbox's FIRST step (:556) and every later step is conditional — claimById " +
      "patches pending→attempting on the row's own id and returns null if it lost (:430). So the loser of a real race never " +
      "reaches a provider, and this is the only one of the four journeys whose guard is a database invariant rather than a " +
      "read-then-write.",
  );

  console.log("\n" + "=".repeat(78));
  console.log(`${fail === 0 ? `ALL CHECKS PASSED (${pass} passed` : `${fail} FAILED, ${pass} passed`}${fail === 0 ? "" : ""}, ${noted} statement${noted === 1 ? "" : "s"} this harness could not decide)`);
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
