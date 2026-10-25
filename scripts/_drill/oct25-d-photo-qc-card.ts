// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: KYLE'S "QC & DELIVER" CARD STAYS CLOSED FOR THE PHOTOS PHOTO DELIVERY
// APPROVED (audit Oct 25 2026, area D).
//
//   DRILL_PORT=6200 node scripts/_drill/run-all.cjs scripts/_drill/oct25-d-photo-qc-card.ts
//
// Live: 8 of the last 8 approvals in Photo Delivery closed the shoot's media_qa
// card, and minutes later (the photos reaching the listing) the reconciler
// brought it back: "QC reopened: Photos landed on Aryeo after the card was
// closed by hand". 3745 S Saucon Ave's card was still open on Oct 25.
//
//   1. The close ticks the photos' own evidence rows (photos, drone, twilight)
//      and leaves the video's, the floor plan's and virtual staging's alone.
//   2. The reconciler's own test (qcCategoriesLanded, prev = the stored card):
//      the photos going live is no longer "landed after the close"; the video
//      landing still is. The old snapshot would have reopened for the photos.
//   3. A card back for the video is never closed by Photo Delivery; a job in
//      revision is left alone.
//   4. The repair script exists, is a dry run by default and closes only
//      cards back for the photos on a delivered photo job.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6200);
const REPO = path.resolve(__dirname, "../..");
installNextStubs();
const fence = fenceFetch(() => null);

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { APP_SECRET: "isolated-oct25-d-photo-qc-card" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { closeMediaCheckForPhotos } = await import("@/lib/photoDelivery/mediaCheck");
    const { parseChecklist } = await import("@/lib/checklist");
    const { qcCategoriesLanded } = await import("@/lib/qcCategories");
    const { CLOSED_BY_HAND } = await import("@/lib/tasks");

    const CARD = [
      { label: "QC Photos", done: false },
      { label: "QC Drone / aerial", done: false },
      { label: "Verticals & horizontals straight (perspective)", done: false },
      { label: "QC Virtual staging", done: false },
      { label: "QC Reel", done: false },
      { label: "Text on screen spelled right", done: false },
      { label: "QC Floor plan", done: false },
    ];
    const mk = async (street: string, o: { status?: string; sourceDetail?: string | null } = {}) => {
      const client = await prisma.client.create({ data: { name: `${street} Client` } });
      const project = await prisma.project.create({ data: { title: `${street}, Upper Saucon Township, PA`, addressLine: street, clientId: client.id, status: (o.status ?? "REVIEW") as never } });
      const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "READY" } });
      const card = await prisma.smartTask.create({ data: { projectId: project.id, taskType: "media_qa", title: `QC & deliver — ${street}`, assignedKey: "kyle", checklist: JSON.stringify(CARD), sourceDetail: o.sourceDetail ?? null } });
      return { project, job, card };
    };

    // =====================================================================
    c.head("1 · The approval closes the card and ticks the photos' evidence rows only");
    // =====================================================================
    const A = await mk("3745 S Saucon Ave");
    const before = parseChecklist((await prisma.smartTask.findUniqueOrThrow({ where: { id: A.card.id } })).checklist);
    const n = await closeMediaCheckForPhotos(A.job.id, { by: "Kyle Smith", reason: "Photos approved in Photo Delivery", human: true });
    const card = await prisma.smartTask.findUniqueOrThrow({ where: { id: A.card.id } });
    const after = parseChecklist(card.checklist);
    const done = (label: string) => after.find((i) => i.label === label)?.done;
    c.ok("closed once, by hand, with the reason", n === 1 && card.status === "COMPLETED" && card.sourceDetail === CLOSED_BY_HAND && /Photos approved in Photo Delivery by Kyle Smith/.test(card.summary ?? ""), JSON.stringify({ status: card.status, summary: card.summary }));
    c.ok("'QC Photos' and 'QC Drone / aerial' ticked", done("QC Photos") === true && done("QC Drone / aerial") === true, JSON.stringify(after));
    c.ok("the video's, floor plan's and virtual staging's evidence rows untouched", done("QC Reel") === false && done("QC Floor plan") === false && done("QC Virtual staging") === false);
    c.ok("Kyle's own ticks untouched (nothing decided for him)", done("Verticals & horizontals straight (perspective)") === false && done("Text on screen spelled right") === false);
    c.ok("the timeline says why", (await prisma.activity.count({ where: { projectId: A.project.id, body: { startsWith: "Media check closed: Photos approved in Photo Delivery by Kyle Smith" } } })) === 1);

    // =====================================================================
    c.head("2 · The reconciler's test: the photos going live is not 'landed after the close'");
    // =====================================================================
    const live = (labels: string[]) => after.map((i) => (labels.includes(i.label) ? { ...i, done: true } : i));
    const photosLive = qcCategoriesLanded(after, live(["QC Photos", "QC Drone / aerial"]));
    c.ok("the photos reaching the listing: nothing landed, the card stays closed", photosLive.size === 0, JSON.stringify([...photosLive]));
    const videoLive = qcCategoriesLanded(after, live(["QC Photos", "QC Reel"]));
    c.ok("the reel reaching the listing later still brings the card back, for the video alone", videoLive.size === 1 && videoLive.has("Video"), JSON.stringify([...videoLive]));
    const oldWay = qcCategoriesLanded(before, before.map((i) => (i.label === "QC Photos" ? { ...i, done: true } : i)));
    c.ok("(the old close, nothing ticked, read the photos as landed: the bug)", oldWay.has("Photos"));

    // =====================================================================
    c.head("3 · What Photo Delivery never closes");
    // =====================================================================
    const B = await mk("615 Cliff Ln", { sourceDetail: "reopened-for:Video" });
    c.ok("a card back for the video stays open", (await closeMediaCheckForPhotos(B.job.id, { by: "Kyle", reason: "Photos approved in Photo Delivery", human: true })) === 0 && (await prisma.smartTask.findUniqueOrThrow({ where: { id: B.card.id } })).status === "OPEN");
    const C = await mk("1316 Blair Cir", { status: "REVISION" });
    c.ok("a job in revision is left alone", (await closeMediaCheckForPhotos(C.job.id, { by: "Kyle", reason: "Photos approved in Photo Delivery", human: true })) === 0 && (await prisma.smartTask.findUniqueOrThrow({ where: { id: C.card.id } })).status === "OPEN");
    const D = await mk("2865 Greenleaf Ct", { sourceDetail: "reopened-for:Photos" });
    c.ok("a card the bug brought back for the photos closes again, evidence ticked", (await closeMediaCheckForPhotos(D.job.id, { by: "audit", reason: "Photos approved and delivered in Photo Delivery", human: false })) === 1 && parseChecklist((await prisma.smartTask.findUniqueOrThrow({ where: { id: D.card.id } })).checklist).find((i) => i.label === "QC Photos")?.done === true);

    // =====================================================================
    c.head("3b · The delivery order: one history line per sitting");
    // =====================================================================
    const { setDeliveryOrder } = await import("@/lib/photoDelivery/decisions");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await prisma.photoAsset.create({ data: { jobId: A.job.id, name: `p${i}.jpg`, status: "ACTIVE", sequence: i } })).id);
    const orderLines = () => prisma.photoJobEvent.findMany({ where: { jobId: A.job.id, action: { startsWith: "delivery order saved" } }, orderBy: { at: "asc" } });
    for (const perm of [[1, 0, 2, 3], [1, 2, 0, 3], [1, 2, 3, 0], [2, 1, 3, 0]]) await setDeliveryOrder(A.job.id, perm.map((k) => ids[k]), "Jordan Spackman");
    const l1 = await orderLines();
    c.ok("four drags by Jordan: one line, holding the latest order", l1.length === 1 && JSON.parse(l1[0].dataJson ?? "{}").first?.[0] === ids[2] && (await prisma.photoJob.findUniqueOrThrow({ where: { id: A.job.id } })).orderJson === JSON.stringify([2, 1, 3, 0].map((k) => ids[k])), JSON.stringify(l1.map((e) => e.action)));
    await setDeliveryOrder(A.job.id, ids, "Kyle Smith");
    c.ok("Kyle saving next: his own line", (await orderLines()).length === 2);
    const kyleLine = (await orderLines())[1];
    await prisma.photoJobEvent.update({ where: { id: kyleLine.id }, data: { at: new Date(Date.now() - 11 * 60_000) } });
    await setDeliveryOrder(A.job.id, [...ids].reverse(), "Kyle Smith");
    c.ok("Kyle again eleven minutes later: a new line", (await orderLines()).length === 3);

    // =====================================================================
    c.head("4 · The repair script");
    // =====================================================================
    const src = fs.readFileSync(path.join(REPO, "scripts/_live/oct25-d-photo-qc-cards.ts"), "utf8");
    c.ok("dry run unless --apply, and it proves the read-only connection first", /const APPLY = process\.argv\.includes\("--apply"\)/.test(src) && /default_transaction_read_only=on/.test(src) && /read-only guard is NOT proven/.test(src));
    c.ok("only cards back for the photos, on a delivered photo job, not in revision", /sourceDetail: "reopened-for:Photos"/.test(src) && /job\.stage !== "DELIVERED"/.test(src) && /REVISION/.test(src) && /closeMediaCheckForPhotos/.test(src));
    // 1316 Blair Cir, Oct 24: the agent added his own edits to the listing after delivery; the
    // alert said the hub could not check them because "AutoHDR no longer has them" (it never had).
    const check = fs.readFileSync(path.join(REPO, "src/lib/photoDelivery/autohdrCheck.ts"), "utf8");
    c.ok("the after-delivery alert says why a photo could not be checked without claiming AutoHDR lost it", !/AutoHDR no longer has \$\{unchecked/.test(check) && /not in AutoHDR: added on the listing by hand, or the shoot closed/.test(check));
    c.ok("no outbound call", fence.blocked.length === 0, fence.blocked.join(" "));
  } finally {
    c.summary();
    quiet.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
