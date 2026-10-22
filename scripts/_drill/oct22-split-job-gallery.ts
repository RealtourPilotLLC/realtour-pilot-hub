// ---------------------------------------------------------------------------
// DRILL: a split job's new visit (Oct 22 2026, 615 Cliff Ln).
//
// Jordan: "Alex's photos for 615 Cliff never got detected or added to editing
// and updated in the hub." One job, two visits: the Oct 7 exteriors (23) were
// delivered on the listing; the Oct 21 interiors went to AutoHDR from the hub
// as batch 2 (batch 1, the old raws re-sent by mistake, was stopped). The sync
// read only the listing, so the job sat in DELIVERY_MISMATCH and the interiors
// never reached the free check or Kyle. Now:
//   · the new visit's AutoHDR gallery is the job's while it is not on the
//     listing; the job leaves the earlier delivery for EDITING → EDITED; the
//     earlier visit's rows are set aside (GONE, never deleted);
//   · the job links to the new visit's AutoHDR shoot;
//   · the deadline follows the latest visit (deliveryDue, not Oct 13);
//   · a part-pushed listing keeps the AutoHDR gallery; the whole set on the
//     listing is carried over in place, the earlier rows come back, and the
//     job verifies DELIVERED with every photo counted;
//   · a job already in DELIVERY_MISMATCH gets a fresh diff on every check, and
//     the sweep re-checks it hourly;
//   · a single-visit job reads exactly as before.
//
// ISOLATION: PGlite via the shared harness; Aryeo answered in-process.
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Img = { id: string; filename: string; original_url: string; index: number; display_in_gallery: boolean };
const listings = new Map<string, { delivery_status: string; images: Img[]; floor_plans: unknown[] }>();
const fence = fenceFetch(async (url) => {
  if (url.startsWith("https://api.aryeo.com/v1/listings/")) {
    const id = new URL(url).pathname.split("/")[3];
    const l = listings.get(id);
    return l ? json({ data: { id, ...l } }) : json({ message: "not found" }, 404);
  }
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: "D1", ts: "1" });
  return null;
});
const img = (id: string, filename: string, index: number): Img => ({ id, filename, original_url: `https://cdn.aryeo.invalid/${id}.jpg`, index, display_in_gallery: true });

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6122) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const jobs = await import("@/lib/photoDelivery/jobs");
    const delivery = await import("@/lib/photoDelivery/delivery");
    const sweep = await import("@/lib/photoDelivery/verifySweep");
    await saveSecret("aryeo", ["drill", "key", "not", "real"].join("-"));

    const T = (iso: string) => new Date(iso);
    const now0 = T("2026-10-22T12:00:00Z");

    c.head("1 · the deadline rule (pure)");
    const oct13 = T("2026-10-13T21:00:00Z"), oct27 = T("2026-10-27T21:00:00Z"), oct21 = T("2026-10-21T20:15:00Z");
    c.ok("a promise before the latest visit gives way to the project's due date", jobs.photoDueFor({ promisedDueAt: oct13, deliveryDue: oct27 }, oct21)?.getTime() === oct27.getTime());
    c.ok("a promise after the latest visit stands", jobs.photoDueFor({ promisedDueAt: T("2026-10-23T15:00:00Z"), deliveryDue: oct27 }, oct21)?.toISOString() === "2026-10-23T15:00:00.000Z");
    c.ok("no visit started: the promise as before", jobs.photoDueFor({ promisedDueAt: oct13, deliveryDue: oct27 }, null)?.getTime() === oct13.getTime());
    const lv = jobs.latestStartedVisit([{ startAt: T("2026-10-07T17:30:00Z"), status: "SCHEDULED" }, { startAt: oct21, status: "SCHEDULED" }, { startAt: T("2026-10-30T15:00:00Z"), status: "SCHEDULED" }, { startAt: T("2026-10-22T09:00:00Z"), status: "CANCELED" }], now0);
    c.ok("latest started visit: future and cancelled visits never count", lv.started === 2 && lv.start?.getTime() === oct21.getTime());

    c.head("2 · 615 Cliff Ln: the earlier visit delivered, the new visit back from AutoHDR");
    const client = await prisma.client.create({ data: { name: "Alex Drill" } });
    const project = await prisma.project.create({ data: { title: "615 Cliff Ln, Phoenixville, PA", addressLine: "615 Cliff Ln", clientId: client.id, aryeoListingId: "LC", shootDate: oct21, promisedDueAt: oct13, deliveryDue: oct27, status: "SCHEDULED" } });
    await prisma.appointment.create({ data: { aryeoId: "ap-cliff-1", projectId: project.id, startAt: T("2026-10-07T17:30:00Z"), status: "SCHEDULED" } });
    await prisma.appointment.create({ data: { aryeoId: "ap-cliff-2", projectId: project.id, startAt: oct21, status: "SCHEDULED" } });
    const earlier = Array.from({ length: 23 }, (_, k) => img(`old${k + 1}`, `615 Cliff Ln (${k + 1} of 23).jpg`, k));
    listings.set("LC", { delivery_status: "DELIVERED", images: earlier, floor_plans: [] });
    const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "EDITING", slaDueAt: oct13, nextCheckAt: now0 } });
    // The listing as the hub first saw it: the earlier visit, delivered.
    await jobs.syncJobFinals(job.id, T("2026-10-21T20:18:30Z"));
    let j = await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } });
    c.ok("before the new visit's photos: NOT delivered, the job waits in Editing for them (the listing's delivery is the earlier visit's)", j.stage === "EDITING" && !j.deliveredAt, j.stage);
    const wEv = await prisma.photoJobEvent.findFirst({ where: { jobId: job.id, action: { contains: "waiting for the photos from" } } });
    c.ok("…and says what it waits for", !!wEv, wEv?.action);
    await prisma.photoJob.update({ where: { id: job.id }, data: { stage: "DELIVERY_MISMATCH" } }); // the floor-plan mismatch it really sat in

    // Batch 1: the old raws re-sent by mistake, stopped. Batch 2: the interiors, done.
    const N = 36;
    const photos = Array.from({ length: N }, (_, k) => ({ image_uuid: `u${k + 1}`, image_version_uuid: `v${k + 1}`, name: `A75${String(k + 1).padStart(5, "0")}.jpg` }));
    await prisma.photoIntakeBatch.create({ data: { projectId: project.id, batchNo: 1, rawPath: "/raw", filesJson: "[]", fileCount: 69, fingerprint: "f1", seenAt: T("2026-10-21T20:18:31Z"), state: "FAILED", photoshootId: 2317698, sentAt: T("2026-10-21T21:08:31Z") } });
    await prisma.photoIntakeBatch.create({ data: { projectId: project.id, batchNo: 2, rawPath: "/raw", filesJson: "[]", fileCount: 180, fingerprint: "f2", seenAt: T("2026-10-22T11:13:29Z"), state: "DONE", photoshootId: 2320001, address: "615 Cliff Ln (Alex Drill) (more photos 2)", sentAt: T("2026-10-22T11:45:00Z"), doneAt: T("2026-10-22T12:20:00Z"), photosJson: JSON.stringify(photos) } });
    const r1 = await jobs.syncJobFinals(job.id, T("2026-10-22T12:30:00Z"));
    j = await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } });
    c.ok("the gallery read is the new visit's AutoHDR photos", r1.source === "autohdr" && r1.count === N, `${r1.source} ${r1.count}`);
    c.ok("the job leaves the earlier delivery for EDITING (the normal flow)", j.stage === "EDITING", j.stage);
    c.ok("this visit's photos are rows on the job, linked to AutoHDR", (await prisma.photoAsset.count({ where: { jobId: job.id, sourceKind: "AUTOHDR", status: "ACTIVE", autohdrImageUuid: { not: null } } })) === N);
    c.ok("the earlier visit's 23 are set aside (GONE), never deleted", (await prisma.photoAsset.count({ where: { jobId: job.id, sourceKind: "ARYEO", status: "GONE" } })) === 23);
    c.ok("the job links to the new visit's AutoHDR shoot", j.autohdrPhotoshootId === 2320001 && j.autohdrShootName === "615 Cliff Ln (Alex Drill) (more photos 2)", String(j.autohdrPhotoshootId));
    c.ok("the deadline follows the latest visit: Oct 27, not Oct 13", j.slaDueAt?.getTime() === oct27.getTime(), j.slaDueAt?.toISOString());
    c.ok("the stale mismatch diff is cleared", j.deliveryDiffJson === null && j.deliveryCheckNote === null);
    const r2 = await jobs.syncJobFinals(job.id, T("2026-10-22T12:40:00Z"));
    j = await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } });
    c.ok("settled: EDITED, ready for the free check (the listing's old 'delivered' never pulls it back)", j.stage === "EDITED" && r2.source === "autohdr", `${j.stage} ${r2.source}`);

    c.head("2b · Kyle adds ONE photo by hand (Oct 22, 1:04 PM): the job stays his");
    await prisma.photoJob.update({ where: { id: job.id }, data: { stage: "QC_REVIEW" } });
    await prisma.photoAsset.updateMany({ where: { jobId: job.id, autohdrImageUuid: "u36" }, data: { status: "EXCLUDED", excludeReason: "Adding this one manually" } });
    listings.set("LC", { delivery_status: "DELIVERED", images: [...earlier, img("manual1", "DSC07999.jpg", 23)], floor_plans: [] });
    const rM = await jobs.syncJobFinals(job.id, T("2026-10-22T13:04:03Z"));
    j = await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } });
    c.ok("one hand-added photo is not the visit's delivery: still the AutoHDR gallery, still in review", rM.source === "autohdr" && j.stage === "QC_REVIEW", `${rM.source} ${j.stage}`);
    c.ok("…the 35 still to approve stay on the job, the excluded one stays excluded", (await prisma.photoAsset.count({ where: { jobId: job.id, sourceKind: "AUTOHDR", status: "ACTIVE" } })) === N - 1 && (await prisma.photoAsset.count({ where: { jobId: job.id, sourceKind: "AUTOHDR", status: "EXCLUDED" } })) === 1);
    listings.set("LC", { delivery_status: "DELIVERED", images: earlier, floor_plans: [] });
    await prisma.photoAsset.updateMany({ where: { jobId: job.id, autohdrImageUuid: "u36" }, data: { status: "ACTIVE", excludeReason: null } });
    await jobs.syncJobFinals(job.id, T("2026-10-22T13:05:00Z"));

    c.head("3 · Kyle's push lands");
    await prisma.photoJob.update({ where: { id: job.id }, data: { stage: "READY" } });
    const part = Array.from({ length: 10 }, (_, k) => img(`new${k + 1}`, `615 Cliff Ln (${k + 1} of ${N}).jpg`, 23 + k));
    listings.set("LC", { delivery_status: "DELIVERED", images: [...earlier, ...part], floor_plans: [] });
    const r3 = await jobs.syncJobFinals(job.id, T("2026-10-22T13:00:00Z"));
    j = await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } });
    c.ok("10 of 36 on the listing so far: still the AutoHDR gallery, still READY", r3.source === "autohdr" && j.stage === "READY", `${r3.source} ${j.stage}`);
    const all = Array.from({ length: N }, (_, k) => img(`new${k + 1}`, `615 Cliff Ln (${k + 1} of ${N}).jpg`, 23 + k));
    listings.set("LC", { delivery_status: "DELIVERED", images: [...earlier, ...all], floor_plans: [] });
    const r4 = await jobs.syncJobFinals(job.id, T("2026-10-22T13:10:00Z"));
    j = await prisma.photoJob.findUniqueOrThrow({ where: { id: job.id } });
    const rows = await prisma.photoAsset.findMany({ where: { jobId: job.id } });
    c.ok("the whole set on the listing: read from the listing again", r4.source === "aryeo" && r4.count === 23 + N, `${r4.source} ${r4.count}`);
    c.ok("the new visit's rows are carried over in place (AutoHDR link kept)", rows.filter((r) => r.sourceKind === "ARYEO" && r.autohdrImageUuid && r.status === "ACTIVE").length === N);
    c.ok("the earlier visit's rows come back", rows.filter((r) => r.sourceKind === "ARYEO" && !r.autohdrImageUuid && r.status === "ACTIVE").length === 23);
    c.ok("no stray rows: 59 photos, all on the listing", rows.length === 23 + N && rows.every((r) => r.status === "ACTIVE"), String(rows.length));
    c.ok("verified DELIVERED with every photo counted", j.stage === "DELIVERED" && JSON.parse(j.deliveryDiffJson ?? "{}").aryeoCount === 59 && JSON.parse(j.deliveryDiffJson ?? "{}").approved === 59, `${j.stage} ${j.deliveryDiffJson}`);

    c.head("4 · a mismatch refreshes, and clears itself");
    const p2 = await prisma.project.create({ data: { title: "859 Drill St, Philadelphia, PA", clientId: client.id, aryeoListingId: "LL" } });
    await prisma.deliverable.create({ data: { projectId: p2.id, type: "FLOORPLAN" } });
    const j2 = await prisma.photoJob.create({ data: { projectId: p2.id, stage: "DELIVERING", deliveryStartedAt: now0 } });
    const imgs8 = Array.from({ length: 8 }, (_, k) => img(`l${k}`, `l${k}.jpg`, k));
    for (let k = 0; k < 8; k++) await prisma.photoAsset.create({ data: { jobId: j2.id, name: `l${k}.jpg`, sourceKind: "ARYEO", sourceRef: `l${k}`, contentHash: `l${k}`, sequence: k, status: "ACTIVE" } });
    listings.set("LL", { delivery_status: "DELIVERED", images: imgs8.slice(0, 5), floor_plans: [] });
    await delivery.verifyDelivery(j2.id, "drill");
    let s2 = await prisma.photoJob.findUniqueOrThrow({ where: { id: j2.id } });
    c.ok("3 missing + no floor plan: DELIVERY_MISMATCH", s2.stage === "DELIVERY_MISMATCH" && JSON.parse(s2.deliveryDiffJson!).missing.length === 3, s2.deliveryCheckNote ?? "");
    listings.set("LL", { delivery_status: "DELIVERED", images: imgs8, floor_plans: [] });
    await delivery.verifyDelivery(j2.id, "drill");
    s2 = await prisma.photoJob.findUniqueOrThrow({ where: { id: j2.id } });
    c.ok("photos put back: the diff refreshes (0 missing) and the note matches it", s2.stage === "DELIVERY_MISMATCH" && JSON.parse(s2.deliveryDiffJson!).missing.length === 0 && !/approved photo/.test(s2.deliveryCheckNote ?? ""), s2.deliveryCheckNote ?? "");
    c.ok("…without a stage-change entry for each check", (await prisma.photoJobEvent.count({ where: { jobId: j2.id, action: { startsWith: "DELIVERY_MISMATCH → DELIVERY_MISMATCH" } } })) === 0);
    listings.set("LL", { delivery_status: "DELIVERED", images: imgs8, floor_plans: [{ id: "fp" }] });
    const sw1 = await sweep.verifyDeliveringJobs({ now: new Date(Date.now() + 10 * 60_000) });
    s2 = await prisma.photoJob.findUniqueOrThrow({ where: { id: j2.id } });
    c.ok("the sweep leaves a mismatch alone for an hour", s2.stage === "DELIVERY_MISMATCH" && sw1.notDue >= 1, JSON.stringify(sw1));
    const sw2 = await sweep.verifyDeliveringJobs({ now: new Date(Date.now() + 61 * 60_000) });
    s2 = await prisma.photoJob.findUniqueOrThrow({ where: { id: j2.id } });
    c.ok("an hour on, the sweep re-checks it: floor plan added → DELIVERED", s2.stage === "DELIVERED" && sw2.verified >= 1, JSON.stringify(sw2));

    c.head("5 · a single-visit job reads as before");
    const p3 = await prisma.project.create({ data: { title: "12 Plain St, Reading, PA", addressLine: "12 Plain St", clientId: client.id, aryeoListingId: "LP", shootDate: T("2026-10-21T14:00:00Z"), promisedDueAt: T("2026-10-22T21:00:00Z"), deliveryDue: oct27 } });
    await prisma.appointment.create({ data: { aryeoId: "ap-plain-1", projectId: p3.id, startAt: T("2026-10-21T14:00:00Z"), status: "SCHEDULED" } });
    const j3 = await prisma.photoJob.create({ data: { projectId: p3.id, stage: "EDITING", slaDueAt: T("2026-10-22T21:00:00Z") } });
    await prisma.photoIntakeBatch.create({ data: { projectId: p3.id, batchNo: 1, rawPath: "/raw", filesJson: "[]", fileCount: 20, fingerprint: "p1", seenAt: T("2026-10-21T19:00:00Z"), state: "DONE", photoshootId: 3000, sentAt: T("2026-10-21T19:30:00Z"), doneAt: T("2026-10-21T20:00:00Z"), photosJson: JSON.stringify(photos.slice(0, 4).map((p, k) => ({ ...p, image_uuid: `p${k}` }))) } });
    listings.set("LP", { delivery_status: "SCHEDULED", images: [], floor_plans: [] });
    const r5 = await jobs.syncJobFinals(j3.id, now0);
    const s3 = await prisma.photoJob.findUniqueOrThrow({ where: { id: j3.id } });
    c.ok("one visit, nothing on the listing: the AutoHDR gallery, EDITING, deadline kept", r5.source === "autohdr" && r5.count === 4 && s3.stage === "EDITING" && s3.slaDueAt?.toISOString() === "2026-10-22T21:00:00.000Z", `${r5.source} ${r5.count} ${s3.stage} ${s3.slaDueAt?.toISOString()}`);

    c.head("isolation");
    c.ok("nothing left the fakes but Dropbox (unconnected)", fence.blocked.every((u) => /dropbox/.test(u)), fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
