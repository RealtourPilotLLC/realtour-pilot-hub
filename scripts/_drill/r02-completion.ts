/**
 * R02 acceptance drill — CALLS the real computeStatus with the reviewer's own
 * inputs and prints the verdict. No database, no network: computeStatus is
 * pure, so the five acceptance cases can be argued with directly.
 *
 *   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/r02-completion.ts
 *
 * The same file runs against the code BEFORE and AFTER the fix: the unit tally
 * is an optional field, so the old build simply ignores it.
 */
import { computeStatus, type StatusSignals, type MediaCategory } from "../../src/lib/projectStatus";

const DAY = 24 * 3600_000;
const shot = new Date(Date.now() - 6 * DAY);

type Extra = Record<string, unknown>;

function sig(expected: MediaCategory[], over: Extra): StatusSignals {
  const base = {
    expected: new Set<MediaCategory>(expected),
    aryeo: null,
    dropbox: null,
    dropboxUnavailable: false,
    fulfilled: false,
    officeConfirmed: false,
    deliveredBy: null,
    deliveredVia: null,
    scheduled: false,
    anyAppt: true,
    datedAppt: true,
    postponed: false,
    shootDate: shot,
    videoAnchor: shot,
    shootPending: false,
    revisionOpen: false,
    revisionNote: null,
    videoTier: "standard",
    videoType: "SOCIAL_REEL",
    monthlyContent: false,
  };
  return { ...base, ...over } as unknown as StatusSignals;
}

const aryeo = (videos: number, photos = 0) => ({
  photos,
  videos,
  floorPlans: 0,
  interactive: 0,
  delivery: "DELIVERED",
  cover: null,
  at: new Date().toISOString(),
  videoList: Array.from({ length: videos }, (_, i) => ({ id: `vid-${i + 1}`, title: `Video ${i + 1}`, duration: 60 })),
});

const dbx = (finalVideo: number, finalPhotos = 0) => ({
  rawPhotos: 120,
  rawVideo: 8,
  finalPhotos,
  finalVideo,
  at: new Date().toISOString(),
});

const videoUnits = (owed: number, withClient: number, finished: number) => [
  {
    category: "VIDEO",
    owed,
    withClient,
    finished,
    source: "outputs",
    outstandingKeys: Array.from({ length: Math.max(0, owed - withClient) }, (_, i) => `dlv1:${withClient + i + 1}`),
  },
];

function show(name: string, s: StatusSignals) {
  const r = computeStatus(s);
  const e = r.evidence as unknown as Record<string, unknown>;
  console.log(`\n### ${name}`);
  console.log(`  status:       ${r.status}`);
  console.log(`  reason:       ${r.evidence.reason}`);
  console.log(`  missing:      ${JSON.stringify(r.evidence.missing)}`);
  console.log(`  awaitingSend: ${JSON.stringify(r.evidence.awaitingSend)}`);
  console.log(`  units:        ${JSON.stringify(e.units ?? null)}`);
}

console.log("=".repeat(72));
console.log("R02 — individual output evidence vs project completion");
console.log("=".repeat(72));

// ---- THE REVIEWER'S OWN REPRODUCTION ---------------------------------------
// "four finished Dropbox videos and only one Aryeo video returned DELIVERED /
//  All ordered deliverables confirmed live on Aryeo / awaitingSend []"
show("A1  four owed videos, ONE on the listing, four finished in Dropbox", sig(["VIDEO"], {
  aryeo: aryeo(1),
  dropbox: dbx(4),
  fulfilled: true,
  units: videoUnits(4, 1, 4),
}));

// "The result was identical with four Aryeo videos." — that one MUST stay DELIVERED.
show("A2  four owed videos, all FOUR on the listing", sig(["VIDEO"], {
  aryeo: aryeo(4),
  dropbox: dbx(4),
  fulfilled: true,
  units: videoUnits(4, 4, 4),
}));

// ---- ACCEPTANCE ------------------------------------------------------------
show("B  mixed photos + 4 videos, photos out, 1 video out — must not complete early", sig(["PHOTOS", "VIDEO"], {
  aryeo: aryeo(1, 42),
  dropbox: dbx(1, 42),
  fulfilled: true,
  units: videoUnits(4, 1, 1),
}));

show("C  unknown evidence — the Aryeo read FAILED (a stale zero is not an absence)", sig(["PHOTOS", "VIDEO"], {
  aryeo: null,
  dropbox: dbx(4, 42),
  dropboxUnavailable: false,
  fulfilled: true,
  units: videoUnits(4, 0, 4),
}));

show("D  a GENUINE office confirmation — deliveredBy names a person", sig(["VIDEO"], {
  aryeo: aryeo(1),
  dropbox: dbx(4),
  fulfilled: true,
  officeConfirmed: true,
  deliveredBy: "Kyle",
  deliveredVia: "office-hand",
  units: videoUnits(4, 1, 4),
}));

show("E  a sweep-written stamp with NO actor — not a confirmation", sig(["VIDEO"], {
  aryeo: aryeo(1),
  dropbox: dbx(4),
  fulfilled: true,
  officeConfirmed: false,
  deliveredBy: null,
  deliveredVia: "sweep",
  units: videoUnits(4, 1, 4),
}));

show("F  historical delivery must not hide a NEW revision", sig(["VIDEO"], {
  aryeo: aryeo(4),
  dropbox: dbx(4),
  fulfilled: true,
  officeConfirmed: true,
  revisionOpen: true,
  revisionNote: "Can we redo video 3?",
  units: videoUnits(4, 4, 4),
}));

show("G  historical delivery must not hide an ADDED output (4 → 5 owed)", sig(["VIDEO"], {
  aryeo: aryeo(4),
  dropbox: dbx(4),
  fulfilled: true,
  officeConfirmed: true,
  units: videoUnits(5, 4, 4),
}));

// ---- REGRESSION: the single-video world must be byte-identical --------------
show("H  one owed video, one on the listing (the old boolean world)", sig(["PHOTOS", "VIDEO"], {
  aryeo: aryeo(1, 42),
  dropbox: dbx(1, 42),
  fulfilled: true,
  units: videoUnits(1, 1, 1),
}));

show("I  WF-01: one owed video, finished in Dropbox, NOT on the listing", sig(["PHOTOS", "VIDEO"], {
  aryeo: aryeo(0, 42),
  dropbox: dbx(1, 42),
  fulfilled: false,
  units: videoUnits(1, 0, 1),
}));

show("J  no unit tally at all (645 of ~1,500 jobs have no output rows yet)", sig(["PHOTOS", "VIDEO"], {
  aryeo: aryeo(1, 42),
  dropbox: dbx(1, 42),
  fulfilled: true,
}));
