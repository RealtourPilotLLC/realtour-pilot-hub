// The sentence about the listing must come from the listing.
import { computeStatus, type StatusSignals } from "@/lib/projectStatus";
const base = (over: Partial<StatusSignals>): StatusSignals => ({
  aryeo: { photos: 0, videos: 0, floorPlans: 0, interactive: 0, delivery: "DELIVERED", cover: null },
  dropbox: { rawPhotos: 0, rawVideo: 0, finalPhotos: 0, finalVideo: 1 },
  expected: ["VIDEO"], fulfilled: true, officeConfirmed: true,
  deliveredBy: "Kyle", deliveredVia: "office-hand",
  scheduled: false, shootDate: new Date("2026-09-01"), shootPending: false,
  datedAppt: true, postponed: false, revisionOpen: false, revisionNote: null,
  videoTier: "standard", videoType: "VIDEO", monthlyContent: false, videoAnchor: null,
  units: [{ category: "VIDEO", owed: 1, withClient: 1, finished: 1, source: "outputs", keys: ["d:1"] }],
  ...over,
} as StatusSignals);
const cases: [string, StatusSignals][] = [
  ["hand-delivered, listing EMPTY", base({})],
  ["genuinely on the listing", base({ aryeo: { photos: 0, videos: 1, floorPlans: 0, interactive: 0, delivery: "DELIVERED", cover: null } })],
];
let fail = 0;
for (const [label, sig] of cases) {
  const r = computeStatus(sig);
  const claimsAryeo = r.evidence.reason.includes("live on Aryeo");
  const shouldClaim = label.includes("genuinely");
  const ok = claimsAryeo === shouldClaim;
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}`);
  console.log(`        ${r.status} — ${r.evidence.reason.slice(0, 110)}`);
}
console.log(fail === 0 ? "\nPASS — only a listing that carries them says so" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
