/**
 * THE PER-CUT STAMP THE UPLOAD-CARD PASS OWED (Sep 21 2026).
 *
 *   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" \
 *   && set -a && source .env; set +a \
 *   && NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs \
 *        scripts/_drill/percut-stamp.ts
 *
 * Runs the SHIPPED proveListingNow against an ISOLATED in-process PGlite
 * Postgres. Production Neon is never touched — DATABASE_URL is overwritten below
 * before any app module loads.
 *
 * THE INCIDENT. 5 Raymond Cir, 11:28 AM ET today. Kyle uploaded the video to
 * Aryeo and delivered the listing; Aryeo told the hub; the hub proved the video,
 * stamped TopazJob.deliveredAt, closed Kyle's upload card, took the job to
 * DELIVERED and wrote three good timeline lines. And ReviewSubmission
 * .sentToClientAt was still NULL on the cut, with DeliverableOutput slot 1
 * unnamed — so the one record that answers "did THIS FILE go out" was never
 * written on the one occasion Aryeo told us exactly what happened.
 *
 * What this has to show:
 *   1. the fixture is the real shape — a cut with a 1080p job of its own, which
 *      is why the cut-level pass can never stamp it from its side;
 *   2. the proof closes the card AND stamps the cut AND names the video row;
 *   3. a replay writes nothing twice;
 *   4. a card the proof does NOT earn leaves the card open and the cut unstamped
 *      — the guard is doing the work, not the fixtures.
 *
 * ONE THING IS STUBBED, and it is named out loud: Aryeo.listing, a network read
 * a drill must not make. Everything that DECIDES anything — cardsAryeoCanAccount
 * For, closeKylesUploadCards, markTopazDelivered, markVideoSent — is the shipped
 * code.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execFile } from "child_process";
import { promisify } from "util";
import Module from "node:module";

// ---- the one stub, installed before any app module resolves ----------------
/** listing id → the listing Aryeo.listing should hand back. */
const LISTINGS = new Map<string, { delivery_status: string; videos: { id: string; duration: number; title: string }[] }>();

const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
const isModule = (request: string, tail: string) =>
  request === `@/lib/${tail}` || new RegExp(`(^|/)src/lib/${tail}(\\.tsx?)?$`).test(request);
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f };
  if (request === "next/headers") return {};
  const m = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
  if (isModule(request, "integrations/aryeo")) {
    const realAryeo = m.Aryeo as Record<string, unknown>;
    const stubbed = new Proxy(realAryeo, {
      get: (t, k) =>
        k === "listing"
          ? async (id: string) => {
              const l = LISTINGS.get(id);
              if (!l) throw new Error(`404 no such listing ${id}`);
              return l;
            }
          : (t as Record<string | symbol, unknown>)[k],
    });
    return new Proxy(m, { get: (t, k) => (k === "Aryeo" ? stubbed : (t as Record<string | symbol, unknown>)[k]) });
  }
  return m;
};

const exec = promisify(execFile);
const PORT = 5501;
const URL_ = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
process.env.DATABASE_URL = URL_;
process.env.DIRECT_URL = URL_;
delete process.env.AUTH_ENFORCE;

let pass = 0;
let fail = 0;
const ok = (label: string, good: boolean, detail = "") => {
  if (good) pass++;
  else fail++;
  console.log(`  ${good ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

/** A UUIDv7 whose first 48 bits are `ms`, which is how the hub dates a video on
 *  an Aryeo listing (readyToSend.aryeoIdTime). */
function v7(ms: number): string {
  const t = Math.floor(ms).toString(16).padStart(12, "0");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7abc-8def-0123456789ab`;
}

const HOUR = 3600_000;

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  await exec("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { env: { ...process.env } });

  const { prisma } = await import("@/lib/prisma");
  const { proveListingNow } = await import("@/lib/aryeoDelivery");
  const { cutsOnTheCardFor } = await import("@/lib/readyToSend");

  console.log("=".repeat(74));
  console.log("The per-cut stamp — closing Kyle's card is not the same as recording the send");
  console.log("=".repeat(74));

  const client = await prisma.client.create({ data: { name: "Brie Martinez" }, select: { id: true } });
  const T0 = Date.now() - 72 * HOUR; // the cut was approved three days ago

  const mkJob = async (street: string, listingId: string) =>
    prisma.project.create({
      data: {
        title: `${street}, Downingtown, PA 19335`,
        clientId: client.id,
        status: "REVIEW",
        aryeoListingId: listingId,
        aryeoOrderId: `ord-${listingId.slice(0, 8)}`,
      },
      select: { id: true, title: true },
    });

  /** The 5 Raymond Cir shape: an approved cut whose 1080p pass really filed a
   *  file, with the card on Kyle telling him to upload it. */
  const mkRenderedCut = async (
    projectId: string,
    o: { name: string; approvedAt: Date; savedAt: Date; lengthSec: number },
  ) => {
    const d = await prisma.deliverable.create({
      data: { projectId, type: "VIDEO", quantity: 1, productTitle: o.name },
      select: { id: true },
    });
    const out = await prisma.deliverableOutput.create({
      data: { deliverableId: d.id, projectId, slot: 1, category: "VIDEO" },
      select: { id: true },
    });
    const s = await prisma.reviewSubmission.create({
      data: {
        projectId,
        deliverableId: d.id,
        slot: 1,
        round: 1,
        status: "APPROVED",
        fileName: `Done_${o.name}.mov`,
        blobUrl: `https://example.invalid/${encodeURIComponent(o.name)}.mov`,
        sizeBytes: 120_000_000,
        decidedAt: o.approvedAt,
      },
      select: { id: true },
    });
    const task = await prisma.smartTask.create({
      data: {
        taskType: "delivery",
        title: `Upload the 1080p video to Aryeo — ${o.name}`,
        projectId,
        dedupeKey: `topaz-deliver-${s.id}`,
        status: "OPEN",
      },
      select: { id: true },
    });
    const job = await prisma.topazJob.create({
      data: {
        submissionId: s.id,
        projectId,
        state: "done",
        fileName: `Done_${o.name}.mov`,
        sourceDurationSec: o.lengthSec,
        savedAt: o.savedAt,
        finishedAt: o.savedAt,
        finalPath: `/AutoHDR/${o.name}/05-Final-Video/${o.name} - FINAL (Topaz).mp4`,
        taskId: task.id,
      },
      select: { id: true },
    });
    return { submissionId: s.id, jobId: job.id, deliverableId: d.id, outputId: out.id, taskId: task.id };
  };

  // ---- 1: the fixture is the shape the cut-level pass cannot reach ---------
  const L1 = "01a0a0e5-e4c0-705f-a848-c0b89de99171"; // 5 Raymond Cir's real listing id
  const p1 = await mkJob("5 Raymond Cir", L1);
  const cut = await mkRenderedCut(p1.id, {
    name: "Standard Reel - v1",
    approvedAt: new Date(T0),
    savedAt: new Date(T0 + 30 * 60_000),
    lengthSec: 59.393,
  });

  console.log("\n1. THE FIXTURE — an approved cut with a 1080p job of its own, card open on Kyle");
  const onCard = await cutsOnTheCardFor(p1.id);
  ok("the cut is a row the Ready-to-send card is asking for", onCard.has(cut.submissionId), `card shows ${onCard.size}`);
  const before = await prisma.reviewSubmission.findUnique({
    where: { id: cut.submissionId },
    select: { sentToClientAt: true },
  });
  ok("nothing says it has gone yet", before?.sentToClientAt == null);

  // One 59s video, uploaded 3 hours after the 1080p file was filed, and nothing
  // on the listing before it.
  LISTINGS.set(L1, {
    delivery_status: "DELIVERED",
    videos: [{ id: v7(T0 + 3 * HOUR), duration: 59, title: "Cinematic Video" }],
  });

  // ---- 2: the proof closes the card AND records the send ------------------
  console.log("\n2. ARYEO SHOWS THE VIDEO — the card closes and the send is recorded on the file itself");
  const r1 = await proveListingNow(L1, "drill: LISTING_DELIVERED");
  console.log(`   ${r1.note}`);
  ok("the pass closed the upload card", r1.closed === 1, `closed ${r1.closed}`);
  const job = await prisma.topazJob.findUnique({ where: { id: cut.jobId }, select: { deliveredAt: true, deliveredBy: true } });
  ok("TopazJob.deliveredAt is stamped", job?.deliveredAt != null, job?.deliveredBy ?? "");
  const task = await prisma.smartTask.findUnique({ where: { id: cut.taskId }, select: { status: true } });
  ok("Kyle's card is completed", task?.status === "COMPLETED", task?.status ?? "");

  const sub = await prisma.reviewSubmission.findUnique({
    where: { id: cut.submissionId },
    select: { sentToClientAt: true, sentToClientBy: true },
  });
  ok("THE CUT IS STAMPED SENT — the fix", sub?.sentToClientAt != null, sub?.sentToClientBy ?? "nothing");
  ok("the stamp names the video that proved it", (sub?.sentToClientBy ?? "").includes("Cinematic Video"));

  const out = await prisma.deliverableOutput.findUnique({
    where: { id: cut.outputId },
    select: { deliveredAt: true, sentSubmissionId: true, deliveredVia: true, evidenceSource: true },
  });
  ok("the per-VIDEO row is named", out?.deliveredAt != null && out?.sentSubmissionId === cut.submissionId, JSON.stringify(out));
  ok("and it says the channel was the Aryeo listing", out?.deliveredVia === "aryeo-listing" && out?.evidenceSource === "aryeo-listing");

  const stillAsking = await cutsOnTheCardFor(p1.id);
  ok("the row has left the Ready-to-send card", !stillAsking.has(cut.submissionId), `card shows ${stillAsking.size}`);

  // ---- 3: a replay writes nothing twice -----------------------------------
  console.log("\n3. THE SAME EVENT AGAIN — a retry, a replay, and the hourly sweep behind it");
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: "aryeo-wh-seen-" } } });
  // A SECOND, UNPROVEN CUT ON THE SAME JOB, so the replay actually LOOKS.
  // Without it proveListingNow bails at its own "nothing outstanding" guard and
  // the replay would prove only that the guard works. This one also shows the
  // stamped cut consuming the video it already accounts for: the second cut
  // finds nothing free, so it is held rather than cleared by its neighbour's
  // upload.
  const second = await mkRenderedCut(p1.id, {
    name: "Standard Reel - v2",
    approvedAt: new Date(T0 + 5 * HOUR),
    savedAt: new Date(T0 + 6 * HOUR),
    lengthSec: 59.1,
  });
  const stampedAt = sub?.sentToClientAt?.getTime();
  const replay = await proveListingNow(L1, "drill: replay with the cool-down cleared");
  const after = await prisma.reviewSubmission.findUnique({
    where: { id: cut.submissionId },
    select: { sentToClientAt: true, sentToClientBy: true },
  });
  ok("the replay closes nothing and stamps nothing new", replay.closed === 0 && replay.stamped === 0, replay.note);
  ok("the original stamp is untouched", after?.sentToClientAt?.getTime() === stampedAt);
  const outAfter = await prisma.deliverableOutput.findUnique({ where: { id: cut.outputId }, select: { deliveredAt: true } });
  ok("the per-video row is not re-dated", outAfter?.deliveredAt?.getTime() === out?.deliveredAt?.getTime());
  const secondSub = await prisma.reviewSubmission.findUnique({ where: { id: second.submissionId }, select: { sentToClientAt: true } });
  const secondJob = await prisma.topazJob.findUnique({ where: { id: second.jobId }, select: { deliveredAt: true } });
  ok("the stamped cut still owns its video, so the second cut is not cleared by it", secondSub?.sentToClientAt == null && secondJob?.deliveredAt == null);

  // ---- 4: no proof, no stamp ----------------------------------------------
  console.log("\n4. NO PROOF, NO STAMP — a listing whose video was already up before the file existed");
  const L2 = "01a05f2f-1111-7222-8333-444455556666";
  const p2 = await mkJob("453 Cardigan Terrace", L2);
  const unproven = await mkRenderedCut(p2.id, {
    name: "Cardigan Reel - v1",
    approvedAt: new Date(T0),
    savedAt: new Date(T0 + 30 * 60_000),
    lengthSec: 60,
  });
  // The only video up there went up BEFORE the 1080p file was filed, so it
  // cannot be that file — provenBy refuses it and nothing may be written.
  LISTINGS.set(L2, {
    delivery_status: "DELIVERED",
    videos: [{ id: v7(T0 + 10 * 60_000), duration: 60, title: "Cinematic Video" }],
  });
  const r2 = await proveListingNow(L2, "drill: a video that predates the file");
  console.log(`   ${r2.note}`);
  const unprovenJob = await prisma.topazJob.findUnique({ where: { id: unproven.jobId }, select: { deliveredAt: true } });
  const unprovenSub = await prisma.reviewSubmission.findUnique({
    where: { id: unproven.submissionId },
    select: { sentToClientAt: true },
  });
  const unprovenOut = await prisma.deliverableOutput.findUnique({ where: { id: unproven.outputId }, select: { deliveredAt: true } });
  ok("the upload card stays open", unprovenJob?.deliveredAt == null);
  ok("the cut is NOT marked sent", unprovenSub?.sentToClientAt == null);
  ok("the per-video row stays unnamed", unprovenOut?.deliveredAt == null);
  const stillOnCard = await cutsOnTheCardFor(p2.id);
  ok("and the row is still on the card for Kyle", stillOnCard.has(unproven.submissionId));

  console.log("\n" + "=".repeat(74));
  console.log(`${pass} passed, ${fail} failed`);
  console.log("=".repeat(74));
  await server.stop();
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
