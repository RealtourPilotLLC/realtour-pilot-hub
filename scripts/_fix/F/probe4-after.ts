/**
 * READ-ONLY, NO DATABASE. The three defects the Sep 18 reviewer demonstrated,
 * replayed against the FIXED classifier.
 *
 *   npx tsx --env-file=.env scripts/_fix/F/probe4-after.ts
 *
 * TO SEE THE BEFORE. The pre-fix module is one command away, and running the
 * same three inputs through it is the other half of the proof:
 *
 *   git show f3d70a3:src/lib/deliveryExceptions.ts > scripts/_fix/F/_before.ts
 *   # then copy the three inputs below, swapping the fields the old type had:
 *   #   dropboxRead / videoUnitsOwed / videoUnitsSent / cachedAryeoDelivery
 *   #   → cutsSentToClient: 1  (matlack), and drop the other three
 *
 * What it said, measured Sep 18 2026:
 *   893 S Matlack + one stamp  → DELIVERED_ANOTHER_WAY, NO FLAG
 *                                ("1 cut carry sentToClientAt")
 *   45 Heron Hill, cached 60   → OWED, would flag
 *                                ("60 finished files in the Dropbox Final folder")
 *   no Dropbox read at all     → CANNOT_TELL, "nothing finished in Dropbox"
 */
import { classifyDelivery, type DeliveryInput, type ListingRead } from "@/lib/deliveryExceptions";

const listing = (over: Partial<Extract<ListingRead, { readable: true }>> = {}): ListingRead => ({
  readable: true,
  deliveryStatus: "DELIVERED",
  photos: 40,
  videos: 1,
  floorPlans: 3,
  videoTitles: ["Standard Reel"],
  atISO: new Date().toISOString(),
  ...over,
});

const matlack: DeliveryInput = {
  projectId: "cmt32he1k00s4l504qaaaw9kk",
  street: "893 S Matlack St",
  status: "REVIEW",
  deliveredAt: null,
  deliveredBy: null,
  deliveredVia: null,
  expected: ["VIDEO"],
  orderedVideoSlots: 16,
  photoLaneProducts: [],
  dropboxFinalVideo: 6,
  dropboxFinalPhotos: 0,
  dropboxRead: "ok",
  videoUnitsOwed: 16,
  videoUnitsSent: 1,
  finishedCutsUnsent: 0,
  renderingCutsUnsent: 0,
  listing: listing({ deliveryStatus: "UNDELIVERED", photos: 0, videos: 0, floorPlans: 0, videoTitles: [] }),
  exceptionAt: null,
  exceptionNote: null,
  cachedAryeoVideos: 0,
  cachedAryeoPhotos: 0,
  cachedAryeoDelivery: "UNDELIVERED",
};

const heron: DeliveryInput = {
  projectId: "cmqiksm5t009x9k9qgq02x9rd",
  street: "45 Heron Hill Dr",
  status: "DELIVERED",
  deliveredAt: new Date("2026-06-09T16:22:54.000Z"),
  deliveredBy: null,
  deliveredVia: null,
  expected: ["PHOTOS", "VIDEO"],
  orderedVideoSlots: 1,
  photoLaneProducts: ["HDR Photos"],
  dropboxFinalVideo: 1,
  dropboxFinalPhotos: 60,
  dropboxRead: "ok",
  videoUnitsOwed: 1,
  videoUnitsSent: 0,
  finishedCutsUnsent: 0,
  renderingCutsUnsent: 0,
  listing: listing({ photos: 0, videos: 1, floorPlans: 8 }),
  exceptionAt: null,
  exceptionNote: null,
  cachedAryeoVideos: 1,
  cachedAryeoPhotos: 60,
  cachedAryeoDelivery: "DELIVERED",
};

const noDropbox: DeliveryInput = {
  ...heron,
  street: "a job with no Dropbox read",
  dropboxFinalVideo: null,
  dropboxFinalPhotos: null,
  dropboxRead: "never",
  cachedAryeoVideos: null,
  cachedAryeoPhotos: null,
  cachedAryeoDelivery: null,
  listing: listing({ photos: 0, videos: 0, videoTitles: [] }),
};

const show = (label: string, input: DeliveryInput) => {
  const c = classifyDelivery(input);
  console.log(`\n${label}`);
  console.log(`   verdict ${c.verdict}   ${c.flagWorthy ? "would flag" : "NO FLAG"}`);
  for (const l of c.lanes) console.log(`   · ${l.lane} ${l.verdict} — ${l.why}`);
  console.log(`   NOTE: ${c.note}`);
};

console.log("FIXED CLASSIFIER — the same three inputs");
show("DEFECT 1 — 893 S Matlack: 16 owed, 6 finished in Dropbox, ONE video marked sent", matlack);
show("DEFECT 2 — 45 Heron Hill: delivered Jun 9, 60 images were live on a DELIVERED listing, none now", heron);
show("DEFECT 3 — nothing on the listing and NO Dropbox read at all", noDropbox);
