// The older-listings world for the oct24-listing-media-index drill (Oct 24
// 2026), built on top of buildMediaWorld: delivered jobs from before the hub
// kept its own files, each with an Aryeo listing whose videos and photos the
// fake Aryeo serves (LISTINGS). Every name, id and URL is invented; the shapes
// are the ones a live listing read returned on Oct 24 2026 (object, id, title,
// duration, thumbnail_url on image.mux.com, download_url on videos.aryeo.com,
// playback_url on stream.mux.com; images with thumbnail/large/original urls).
import type { PrismaClient } from "@prisma/client";
import { buildMediaWorld } from "./mediaLibrary";

const H = 3_600_000;
const D = 24 * H;

/** A uuid v4-shaped id (an older listing: carries no time). */
export const v4 = (n: number) => `${n.toString(16).padStart(8, "0")}-2a30-477f-a702-e33712124c22`;
/** A uuid v7 id minted at `ms` (Aryeo's ids since 2024: the first 48 bits are the time). */
export const v7 = (ms: number, n: number) => {
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${n.toString(16).padStart(3, "0")}-8000-${n.toString(16).padStart(12, "0")}`;
};

export type FakeVideo = { id: string; title: string | null; duration?: number | null };
export const video = (v: FakeVideo, listingUuid = "b92b4dd7-9846-4be3-8e8e-4677bcf3aec9") => ({
  object: "VIDEO", id: v.id, title: v.title, duration: v.duration ?? null, display_type: "BOTH", source_type: "OPTIMIZED",
  thumbnail_url: `https://image.mux.com/${v.id}/thumbnail.png?width=800&height=450&smart_crop=true&time=1`,
  download_url: `https://videos.aryeo.com/listings/${listingUuid}/${v.id}.mp4`,
  playback_url: `https://stream.mux.com/${v.id}`,
  share_url: `https://media.realtourpilot.com/videos/${v.id}`,
});
export const images = (slug: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    object: "PHOTO", id: `img-${slug}-${i + 1}`, index: i + 1, caption: null, display_in_gallery: true, filename: `${slug} (${i + 1} of ${n}).jpg`,
    original_url: `https://cdn.aryeo.com/listings/${slug}/img-${i + 1}.jpeg`,
    large_url: `https://cdn.aryeo.com/listings/${slug}/resized/large/large-img-${i + 1}.jpeg`,
    thumbnail_url: `https://cdn.aryeo.com/listings/${slug}/resized/thumbnail/thumbnail-img-${i + 1}.jpeg`,
  }));
export const listing = (id: string, vids: FakeVideo[], photos: ReturnType<typeof images> = [], coverIndex = 0) => ({
  object: "LISTING", id, delivery_status: "DELIVERED",
  thumbnail_url: photos[coverIndex]?.thumbnail_url ?? null, large_thumbnail_url: photos[coverIndex]?.large_url ?? null,
  images: photos, videos: vids.map((v) => video(v)), floor_plans: [], interactive_content: [], files: [],
});

export async function buildIndexWorld(prisma: PrismaClient, T: Date) {
  const w = await buildMediaWorld(prisma, T);
  const ago = (ms: number) => new Date(T.getTime() - ms);
  const client = (name: string, extra: Record<string, unknown> = {}) => prisma.client.create({ data: { name, phone: "2155550123", ...extra } });
  const olive = await client("Older Olive");
  const pat = await client("Plan Pat", { socialClient: true, socialPlan: "Accelerator" });
  const ben = await client("Brand Ben");
  const project = (data: Record<string, unknown>) => prisma.project.create({ data: data as never });
  const del = (projectId: string, type: string, extra: Record<string, unknown> = {}) => prisma.deliverable.create({ data: { projectId, type: type as never, ...extra } });

  // ---- the ids Aryeo gives each video ----
  const id = {
    alphaReel: v7(T.getTime() - 3 * D, 1), alphaCine: v7(T.getTime() - 3 * D, 2), alphaCineRev: v7(T.getTime() - 2 * D, 3),
    moOneDay: "v-oneday", moLot: "v-lot", moTip: v7(T.getTime() - 4 * D, 4),
    a1: v4(0xa1), a2: v4(0xa2), b1: v4(0xb1), b2: v4(0xb2), c1: v4(0xc1), c2: v4(0xc2), d1: v4(0xd1), e1: v4(0xe1), f1: v4(0xf1),
    g1: v4(0x91), g2: v4(0x92), h1: v7(T.getTime() - 199 * D, 0x81), h2: v7(T.getTime() - 18 * D, 0x82), q1: v4(0x71), q2: v4(0x72),
    r1: v4(0x61), t1: v4(0x51), x1: v4(0x41),
  };

  // Older jobs, no hub cuts (before Aug 2026).
  const pA = await project({ clientId: olive.id, title: "100 Old Premium Rd, Oldtown, PA 19100", status: "DELIVERED", deliveredAt: ago(300 * D), aryeoListingId: "L-A" });
  await del(pA.id, "SOCIAL_REEL", { productTitle: "Premium Social Media Reel", videoStyle: "premium_social_reel" });
  const pB = await project({ clientId: olive.id, title: "200 Two Types Ln, Oldtown, PA 19100", status: "DELIVERED", deliveredAt: ago(280 * D), aryeoListingId: "L-B" });
  await del(pB.id, "VIDEO", { productTitle: "Premium Cinematic Video", videoStyle: "premium_cinematic" });
  await del(pB.id, "SOCIAL_REEL", { productTitle: "Premium Social Media Reel", videoStyle: "premium_social_reel" });
  // Rows with no recorded type (the label is all there is): resolved by the hub's own reading of the label.
  const pC = await project({ clientId: olive.id, title: "300 Labels Only St, Oldtown, PA 19100", status: "DELIVERED", deliveredAt: ago(260 * D), aryeoListingId: "L-C" });
  await del(pC.id, "VIDEO", { label: "Video" });
  await del(pC.id, "SOCIAL_REEL", { label: "Social Reel" });
  const pD = await project({ clientId: olive.id, title: "400 Agent Intro Way, Oldtown, PA 19100", status: "DELIVERED", deliveredAt: ago(240 * D), aryeoListingId: "L-D" });
  await del(pD.id, "SOCIAL_REEL", { productTitle: "Standard Reel with Agent Intro", videoStyle: "standard_reel_agent_intro" });
  // A social-plan client's session before the program had months: Monthly social by her plan.
  const pE = await project({ clientId: pat.id, title: "Plan Pat Content Session", status: "DELIVERED", deliveredAt: ago(220 * D), aryeoListingId: "L-E" });
  await del(pE.id, "PHOTOS");
  // A listing video on a job that recorded no video row at all.
  const pF = await project({ clientId: olive.id, title: "600 Photos Only Ct, Oldtown, PA 19100", status: "DELIVERED", deliveredAt: ago(200 * D), aryeoListingId: "L-F" });
  await del(pF.id, "PHOTOS");
  // A branding package sold outside the program.
  const pG = await project({ clientId: ben.id, title: "700 Branding Blvd, Oldtown, PA 19100", status: "DELIVERED", deliveredAt: ago(180 * D), aryeoListingId: "L-G" });
  await del(pG.id, "VIDEO", { productTitle: "Custom Branding Video Package 4 Videos", videoStyle: "personal_branding", quantity: 4 });
  // One listing, two jobs (a second shoot on the same listing).
  const pH1 = await project({ clientId: olive.id, title: "800 Shared Listing Dr, Oldtown, PA 19100", status: "DELIVERED", deliveredAt: ago(198 * D), aryeoListingId: "L-H" });
  await del(pH1.id, "VIDEO", { productTitle: "Standard Cinematic Video", videoStyle: "standard_cinematic" });
  const pH2 = await project({ clientId: olive.id, title: "800 Shared Listing Dr, Oldtown, PA 19100", status: "DELIVERED", deliveredAt: ago(20 * D), aryeoListingId: "L-H" });
  await del(pH2.id, "VIDEO", { productTitle: "Standard Cinematic Video", videoStyle: "standard_cinematic" });
  // Two reels owed, the hub holds one (title + length match it); the other is the listing's only copy.
  const pQ = await project({ clientId: olive.id, title: "900 Two Reels Pl, Oldtown, PA 19100", status: "DELIVERED", deliveredAt: ago(40 * D), aryeoListingId: "L-Q" });
  const dQ = await del(pQ.id, "SOCIAL_REEL", { productTitle: "Standard Reel", videoStyle: "standard_reel", quantity: 2 });
  const cQ = await prisma.reviewSubmission.create({ data: { kind: "video", projectId: pQ.id, deliverableId: dQ.id, slot: 1, round: 1, status: "APPROVED", fileName: "Reel one.mov", blobUrl: "https://drillstore.public.blob.vercel-storage.com/cuts/cq.mov", sourceWidth: 1080, sourceHeight: 1920, decidedAt: ago(41 * D), sentToClientAt: ago(40 * D) } as never });
  await prisma.topazJob.create({ data: { submissionId: cQ.id, projectId: pQ.id, state: "skipped", sourceDurationSec: 30.2 } as never });
  // Not delivered yet: never in the library, whatever the index holds.
  const pR = await project({ clientId: olive.id, title: "1000 In Review Rd, Oldtown, PA 19100", status: "REVIEW", aryeoListingId: "L-R" });
  await del(pR.id, "VIDEO", { productTitle: "Standard Cinematic Video", videoStyle: "standard_cinematic" });
  // Aryeo answers 404 for this one; this one fails at the network.
  const pGone = await project({ clientId: olive.id, title: "1100 Deleted Listing Rd, Oldtown, PA 19100", status: "DELIVERED", deliveredAt: ago(500 * D), aryeoListingId: "L-GONE" });
  const pFlaky = await project({ clientId: olive.id, title: "1200 Flaky Ln, Oldtown, PA 19100", status: "DELIVERED", deliveredAt: ago(510 * D), aryeoListingId: "L-FLAKY" });

  // A hub upload receipt naming the Aryeo id the reel went up as (the hub's push).
  await prisma.auditLog.create({ data: { actor: "hub", action: "video_uploaded", target: w.c1b.id, detail: JSON.stringify({ submissionId: w.c1b.id, listingId: "L-alpha", mediaIds: [id.alphaReel], by: "hub-aryeo-push" }) } });

  const LISTINGS: Record<string, unknown> = {
    "L-alpha": listing("L-alpha", [
      { id: id.alphaReel, title: "Premium Social Media Reel", duration: 48 },
      { id: id.alphaCine, title: "Cinematic Video", duration: 92 },
      { id: id.alphaCineRev, title: "Cinematic Video Revision", duration: 92 },
    ], images("10-alpha-st", 41)),
    "L-mo": listing("L-mo", [
      { id: id.moOneDay, title: "One Day in Townville #1", duration: 51 },
      { id: id.moLot, title: "Lot video", duration: 44 },
      { id: id.moTip, title: "Tip #3 Staging Sells", duration: 35 },
    ]),
    "L-test": listing("L-test", [{ id: id.t1, title: "Test video", duration: 10 }], images("test", 2)),
    "L-cancel": listing("L-cancel", [{ id: id.x1, title: "Cancelled video", duration: 10 }]),
    "L-A": listing("L-A", [{ id: id.a1, title: "Premium Social Media Reel", duration: 61 }, { id: id.a2, title: "Premium Social Media Reel (REVISED)", duration: 64 }], images("100-old-premium-rd", 5), 1),
    "L-B": listing("L-B", [{ id: id.b1, title: "Premium Cinematic Video", duration: 116 }, { id: id.b2, title: "Premium Social Media Reel", duration: 62 }], images("200-two-types-ln", 3)),
    "L-C": listing("L-C", [{ id: id.c1, title: "Cinematic video", duration: 60 }, { id: id.c2, title: "Vertical Social Reel", duration: 30 }]),
    "L-D": listing("L-D", [{ id: id.d1, title: "Standard Reel w/ Agent intro", duration: 72 }]),
    "L-E": listing("L-E", [{ id: id.e1, title: "Why I Love West Chester", duration: 40 }]),
    "L-F": listing("L-F", [{ id: id.f1, title: "Drone clip", duration: 25 }, { id: "", title: "no id" }, { id: v4(0xf9), title: "no file" }], images("600-photos-only-ct", 12)),
    "L-G": listing("L-G", [{ id: id.g1, title: "Video 1", duration: 31 }, { id: id.g2, title: null, duration: 28 }]),
    "L-H": listing("L-H", [{ id: id.h1, title: "Cinematic Video", duration: 60 }, { id: id.h2, title: "Cinematic Video - Second Shoot", duration: 58 }]),
    "L-Q": listing("L-Q", [{ id: id.q1, title: "Reel one", duration: 30 }, { id: id.q2, title: "Reel two", duration: 45 }]),
    "L-R": { ...listing("L-R", [{ id: id.r1, title: "Not yet delivered", duration: 50 }]), delivery_status: "UNDELIVERED" },
  };
  // The fake's "no file" video carries no download or playback address.
  const f = LISTINGS["L-F"] as { videos: Record<string, unknown>[] };
  f.videos[2] = { ...f.videos[2], download_url: null, playback_url: null };

  return { ...w, olive, pat, ben, pA, pB, pC, pD, pE, pF, pG, pH1, pH2, pQ, cQ, pR, pGone, pFlaky, id, LISTINGS };
}
