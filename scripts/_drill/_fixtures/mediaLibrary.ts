// A small media-library world for the oct23-media-* drills (Oct 23 2026):
// listing videos of every type, a monthly client with a portal library (a hub
// cut and an Aryeo delivery of the same video, plus one Aryeo-only), a
// branding package, a premium reel on a monthly job, a test client, a
// cancelled job, and delivered listings for the Photos tab (one address shot
// twice, one the status engine looked at and found no photos on). Built on a
// disposable PGlite only; every name and URL is invented.
import type { PrismaClient } from "@prisma/client";

const H = 3_600_000;
const D = 24 * H;

export async function buildMediaWorld(prisma: PrismaClient, T: Date) {
  const ago = (ms: number) => new Date(T.getTime() - ms);
  const client = (name: string) => prisma.client.create({ data: { name, phone: "2155550100" } });
  const alpha = await client("Agent Alpha");
  const mo = await client("Monthly Mo");
  const bea = await client("Branding Bea");
  const test = await client("Jordan Spackman TEST");

  const evidence = (photos: number, cover: string | null) =>
    JSON.stringify({ expected: ["Photos"], present: ["Photos"], aryeo: { photos, videos: 1, floorPlans: 0, interactive: 0, delivery: "DELIVERED", cover, at: ago(D).toISOString(), videoList: [] }, checkedAt: ago(D).toISOString() });
  const project = (data: Record<string, unknown>) => prisma.project.create({ data: data as never });

  // ---- listing jobs ----
  const p1 = await project({
    clientId: alpha.id, title: "10 Alpha St, Townville, PA 19000", status: "DELIVERED", deliveredAt: ago(2 * D), aryeoListingId: "L-alpha",
    coverImageUrl: "https://cdn.aryeo.com/listings/10-alpha-st/cover.jpg", statusEvidence: evidence(41, "https://cdn.aryeo.com/listings/10-alpha-st/cover.jpg"),
  });
  const del = (projectId: string, type: string, extra: Record<string, unknown> = {}) => prisma.deliverable.create({ data: { projectId, type: type as never, ...extra } });
  const d1reel = await del(p1.id, "SOCIAL_REEL", { productTitle: "Social Influencer", videoStyle: "premium_social_reel", label: "Premium Reel" });
  const d1video = await del(p1.id, "VIDEO", { productTitle: "Standard Cinematic Video", videoStyle: "standard_cinematic" });
  await del(p1.id, "PHOTOS", { productTitle: "Standard Package" });
  await del(p1.id, "FLOORPLAN");

  const cut = (data: Record<string, unknown>) => prisma.reviewSubmission.create({ data: { kind: "video", ...data } as never });
  const BLOB = "https://drillstore.public.blob.vercel-storage.com/cuts";
  // The premium reel: round 1 delivered, then round 2 replaced it (the library shows round 2 only).
  const c1 = await cut({ projectId: p1.id, deliverableId: d1reel.id, slot: 1, round: 1, status: "APPROVED", fileName: "Alpha reel v1.mov", blobUrl: `${BLOB}/c1.mov`, sourceWidth: 1080, sourceHeight: 1920, decidedAt: ago(4 * D), sentToClientAt: ago(4 * D), assetPath: "/Final/alpha-v1.mov" });
  const c1b = await cut({ projectId: p1.id, deliverableId: d1reel.id, slot: 1, round: 2, status: "APPROVED", fileName: "Alpha reel v2.mov", blobUrl: `${BLOB}/c1b.mov`, sourceWidth: 1080, sourceHeight: 1920, decidedAt: ago(3 * D), sentToClientAt: ago(2 * D) });
  await prisma.topazJob.create({ data: { submissionId: c1b.id, projectId: p1.id, state: "done", finalPath: "/Final Video/Alpha reel v2 1080p.mp4", savedAt: ago(3 * D), outputCheck: "verified", outputWidth: 1080, outputHeight: 1920, sourceDurationSec: 47.6 } });
  // The cinematic video: no send stamp, but the job is delivered; the editor's own file (no Topaz).
  const c2 = await cut({ projectId: p1.id, deliverableId: d1video.id, slot: 1, round: 1, status: "APPROVED", fileName: "Alpha cinematic.mp4", blobUrl: `${BLOB}/c2.mp4`, sourceWidth: 1920, sourceHeight: 1080, decidedAt: ago(3 * D) });
  // Still waiting on a verdict: never in the library.
  const c3 = await cut({ projectId: p1.id, deliverableId: d1video.id, slot: 1, round: 2, status: "PENDING", fileName: "Alpha cinematic v2.mp4", blobUrl: `${BLOB}/c3.mp4` });

  const p2 = await project({ clientId: alpha.id, title: "22 Beta Rd, Townville, PA 19000", status: "REVIEW", aryeoListingId: "L-beta" });
  const d2 = await del(p2.id, "SOCIAL_REEL", { productTitle: "Standard Reel with Agent Intro", videoStyle: "standard_reel_agent_intro" });
  // Approved, not sent, job still in review: not done.
  const c4 = await cut({ projectId: p2.id, deliverableId: d2.id, slot: 1, round: 1, status: "APPROVED", fileName: "Beta reel.mov", blobUrl: `${BLOB}/c4.mov`, decidedAt: ago(H) });

  // ---- the monthly program ----
  const enrollment = await prisma.contentEnrollment.create({ data: { clientId: mo.id, package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4 } });
  const month = await prisma.contentMonth.create({ data: { enrollmentId: enrollment.id, clientId: mo.id, monthKey: "2026-10", videosOwed: 4 } });
  const p3 = await project({ clientId: mo.id, title: "Heathers Way Invitational", status: "DELIVERED", deliveredAt: ago(5 * D), contentMonthId: month.id, aryeoListingId: "L-mo" });
  const d3 = await del(p3.id, "VIDEO", { productTitle: "Video Accelerator - 4HR Session", videoStyle: "personal_branding", quantity: 4 });
  const topic = await prisma.contentTopic.create({ data: { enrollmentId: enrollment.id, clientId: mo.id, monthId: month.id, title: "Why Your Lot Decides Your Floor Plan" } });
  const cv1 = await prisma.contentVideo.create({ data: { enrollmentId: enrollment.id, clientId: mo.id, monthId: month.id, monthKey: "2026-10", title: "Lot video v1", topicId: topic.id, projectId: p3.id, deliverableId: d3.id, slot: 1 } });
  const cv2 = await prisma.contentVideo.create({ data: { enrollmentId: enrollment.id, clientId: mo.id, monthId: month.id, monthKey: "2026-10", title: "One Day in Townville #1", projectId: p3.id } });
  // The hub cut of video 1: approved, never "sent", but its portal row says when the client got it.
  const c5 = await cut({ projectId: p3.id, deliverableId: d3.id, slot: 1, round: 1, status: "APPROVED", fileName: "Lot video v1.mov", blobUrl: `${BLOB}/c5.mov`, sourceWidth: 1080, sourceHeight: 1920, decidedAt: ago(3 * D), videoId: cv1.id });
  await prisma.portalVideo.create({ data: { enrollmentId: enrollment.id, monthId: month.id, projectId: p3.id, title: "Lot video v1.mov", playback: `/api/review/cut/${c5.id}/stream`, download: `/api/review/cut/${c5.id}/stream`, source: "review", externalKey: `sub:${c5.id}`, deliveredAt: ago(3 * D), videoId: cv1.id } });
  // The same video 1 delivered earlier through the Aryeo listing (older): the hub's newer cut wins, Aryeo's poster is kept.
  await prisma.portalVideo.create({ data: { enrollmentId: enrollment.id, monthId: month.id, projectId: p3.id, title: "Lot video", thumb: "https://image.mux.com/lot/thumbnail.jpg", playback: "https://stream.mux.com/lot", download: "https://videos.aryeo.com/lot.mov", source: "aryeo", externalKey: "aryeo:L-mo:v-lot", deliveredAt: ago(9 * D), videoId: cv1.id } });
  // An Aryeo-only program video.
  const pvOneDay = await prisma.portalVideo.create({ data: { enrollmentId: enrollment.id, monthId: month.id, projectId: p3.id, title: "One Day in Townville #1", thumb: "https://image.mux.com/oneday/thumbnail.jpg", playback: "https://stream.mux.com/oneday", download: "https://videos.aryeo.com/oneday.mp4", source: "aryeo", externalKey: "aryeo:L-mo:v-oneday", deliveredAt: ago(20 * D), videoId: cv2.id } });

  // A premium reel bought on the monthly client's job: premium wins over monthly.
  const p5 = await project({ clientId: mo.id, title: "5 Gamma Ct, Townville, PA 19000", status: "DELIVERED", deliveredAt: ago(6 * D), contentMonthId: month.id, aryeoListingId: "L-gamma" });
  const d5 = await del(p5.id, "SOCIAL_REEL", { productTitle: "Premium Social Media Reel", videoStyle: "premium_social_reel" });
  const c7 = await cut({ projectId: p5.id, deliverableId: d5.id, slot: 1, round: 1, status: "APPROVED", fileName: "Gamma premium.mov", assetPath: "/Final/gamma.mov", sourceWidth: 1080, sourceHeight: 1920, decidedAt: ago(7 * D), sentToClientAt: ago(6 * D) });

  // ---- a branding package outside the program ----
  const p4 = await project({ clientId: bea.id, title: "893 Branding Ln, West Town, PA 19382", status: "DELIVERED", deliveredAt: ago(8 * D), aryeoListingId: "L-bea" });
  const d4 = await del(p4.id, "VIDEO", { productTitle: "Custom Branding Video Package 16 Videos Total", videoStyle: "personal_branding", quantity: 16 });
  const c6 = await cut({ projectId: p4.id, deliverableId: d4.id, slot: 3, round: 1, status: "APPROVED", fileName: "V1_3.mov", blobUrl: `${BLOB}/c6.mov`, sourceWidth: 1080, sourceHeight: 1920, decidedAt: ago(9 * D), sentToClientAt: ago(8 * D) });

  // ---- left out: a test client, a cancelled job ----
  const p6 = await project({ clientId: test.id, title: "1 Test Way, Townville", status: "DELIVERED", deliveredAt: ago(D), aryeoListingId: "L-test", coverImageUrl: "https://cdn.aryeo.com/listings/test/cover.jpg" });
  const d6 = await del(p6.id, "VIDEO", { productTitle: "Standard Cinematic Video", videoStyle: "standard_cinematic" });
  const c8 = await cut({ projectId: p6.id, deliverableId: d6.id, slot: 1, round: 1, status: "APPROVED", fileName: "Test.mp4", blobUrl: `${BLOB}/c8.mp4`, decidedAt: ago(D), sentToClientAt: ago(D) });
  const p7 = await project({ clientId: alpha.id, title: "7 Cancelled Ave, Townville", status: "CANCELLED", aryeoListingId: "L-cancel" });
  const d7 = await del(p7.id, "VIDEO", { productTitle: "Standard Cinematic Video", videoStyle: "standard_cinematic" });
  const c9 = await cut({ projectId: p7.id, deliverableId: d7.id, slot: 1, round: 1, status: "APPROVED", fileName: "Cancelled.mp4", blobUrl: `${BLOB}/c9.mp4`, decidedAt: ago(D), sentToClientAt: ago(D) });

  // ---- photos: the same address shot a year earlier (no evidence, photos ordered) ----
  const p8 = await project({ clientId: alpha.id, title: "10 Alpha St, Townville, PA 19000", status: "DELIVERED", deliveredAt: ago(400 * D), aryeoListingId: "L-alpha-2025" });
  await del(p8.id, "PHOTOS", { productTitle: "Bronze" });
  // Looked at, no photos on the listing: not a photo tile (still a delivered listing).
  const p9 = await project({ clientId: alpha.id, title: "9 Video Only Ln, Townville, PA 19000", status: "DELIVERED", deliveredAt: ago(3 * D), aryeoListingId: "L-videoonly", statusEvidence: evidence(0, null) });
  await del(p9.id, "VIDEO", { productTitle: "Standard Cinematic Video", videoStyle: "standard_cinematic" });
  // Delivered but no Aryeo listing: not a listing at all.
  const p10 = await project({ clientId: alpha.id, title: "12 No Listing Rd, Townville", status: "DELIVERED", deliveredAt: ago(3 * D) });
  await del(p10.id, "PHOTOS");

  return { alpha, mo, bea, test, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, c1, c1b, c2, c3, c4, c5, c6, c7, c8, c9, cv1, cv2, pvOneDay, enrollment, month, topic };
}

/** A whole page of photo listings, so "Show more" has something to show. */
export async function buildManyListings(prisma: PrismaClient, T: Date, n: number) {
  const c = await prisma.client.create({ data: { name: "Bulk Broker", phone: "2155550199" } });
  for (let i = 0; i < n; i++) {
    const p = await prisma.project.create({
      data: {
        clientId: c.id, title: `${100 + i} Bulk Way, Manytown, PA 19001`, status: "DELIVERED", deliveredAt: new Date(T.getTime() - (30 + i) * D),
        aryeoListingId: `L-bulk-${i}`, coverImageUrl: `https://cdn.aryeo.com/listings/bulk-${i}/cover.jpg`,
        statusEvidence: JSON.stringify({ aryeo: { photos: 20 + i, videos: 0, floorPlans: 0, interactive: 0, delivery: "DELIVERED", cover: null } }),
      },
    });
    await prisma.deliverable.create({ data: { projectId: p.id, type: "PHOTOS" } });
  }
  return c;
}
