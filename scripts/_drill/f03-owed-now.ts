/**
 * F03 — one definition of what is still owed, used by the gates and not only
 * the card.
 *
 * Before this fix the Editing Room's Completed pill read a single blob field,
 * `missing`, which the status engine EMPTIES the moment an editor cuts a video
 * into our Dropbox Final folder (present = clientHas UNION weHave). So four
 * videos finished, none on the client's listing, returned no blockers and the
 * job was written DELIVERED with a "how did we do?" text behind it.
 *
 *   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
 *   set -a && source .env; set +a && \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/f03-owed-now.ts
 *
 * Parts 1, 2 and 4 are pure (no database). Part 3 is a read-only SELECT over
 * live production: it recomputes the gate against every blob and must report
 * ZERO jobs where the gate passes while the same blob says something is owed.
 */
import { computeStatus, type StatusSignals, type MediaCategory } from "../../src/lib/projectStatus";
import { parseEvidence, evidenceTone, owedNow, owedPhrase } from "../../src/lib/statusEvidence";
import { neverMadeOnly, outstandingForDelivery, outstandingMessage, deliveryMessage } from "../../src/lib/delivery";

const DAY = 86_400_000;
const shot = new Date(Date.now() - 6 * DAY);
let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

function sig(expected: MediaCategory[], over: Record<string, unknown>): StatusSignals {
  return {
    expected: new Set<MediaCategory>(expected),
    aryeo: null, dropbox: null, dropboxUnavailable: false,
    fulfilled: false, officeConfirmed: false, deliveredBy: null, deliveredVia: null,
    scheduled: false, anyAppt: true, datedAppt: true, postponed: false,
    shootDate: shot, videoAnchor: shot, shootPending: false,
    revisionOpen: false, revisionNote: null,
    videoTier: "standard", videoType: "SOCIAL_REEL", monthlyContent: false,
    ...over,
  } as unknown as StatusSignals;
}
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// PART 1 — the audit's fixture, driven through the REAL engine.
// 5642 Limeport Rd, near enough verbatim: four videos owed, four cut and
// parked in Dropbox, one anonymous video on the listing, three outstanding.
// ---------------------------------------------------------------------------
console.log("PART 1 — four videos finished, one with the client, three outstanding");
const r1 = computeStatus(sig(["PHOTOS", "VIDEO"], {
  aryeo: { photos: 40, videos: 1, floorPlans: 0, interactive: 0, delivery: null, cover: null, at: nowIso() },
  dropbox: { rawPhotos: 220, rawVideo: 9, finalPhotos: 40, finalVideo: 4, at: nowIso() },
  units: [{ category: "VIDEO", owed: 4, withClient: 1, finished: 4, source: "outputs", outstandingKeys: ["dlv1:2", "dlv1:3", "dlv1:4"] }],
}));
const blob1 = JSON.stringify(r1.evidence);
const ev1 = parseEvidence(blob1);
const gate1 = outstandingForDelivery(blob1);
console.log(`  engine status         : ${r1.status}`);
console.log(`  evidence.missing      : ${JSON.stringify(ev1?.missing)}`);
console.log(`  evidence.awaitingSend : ${JSON.stringify(ev1?.awaitingSend)}`);
console.log(`  owedNow().categories  : ${JSON.stringify(owedNow(ev1).categories)}`);
console.log(`  gate                  : ${JSON.stringify(gate1.categories)}`);
console.log(`  refusal               : ${outstandingMessage(gate1)}`);
console.log(`  timeline clause       : ${owedPhrase(gate1) || "(nothing missing)"}`);
check("the pill is refused", gate1.categories.length > 0, `blockers ${JSON.stringify(gate1.categories)}`);
check("the refusal names the count", /3 of 4 videos/.test(outstandingMessage(gate1)), outstandingMessage(gate1));
check("the refusal names a way forward", /Refresh from Aryeo/.test(outstandingMessage(gate1)), "");
check("the timeline row is not silent", owedPhrase(gate1).length > 0, owedPhrase(gate1));
check(
  "the card and the gate agree something is owed",
  evidenceTone({ status: r1.status, evidence: ev1 }).kind !== "clear" && gate1.categories.length > 0,
  `card=${evidenceTone({ status: r1.status, evidence: ev1 }).headline}`,
);

// ---------------------------------------------------------------------------
// PART 2 — the edges of the definition.
//
// Two of these exist because the FIRST cut of this fix counted a unit
// shortfall as an obligation in its own right. It cannot be: the engine
// deliberately silences the owed-send question when the listing read failed
// and when a person is on record for the delivery, and a standalone shortfall
// overruled both, refusing a job on a listing fact nobody had.
// ---------------------------------------------------------------------------
console.log("\nPART 2 — the edges");
const r2 = computeStatus(sig(["PHOTOS", "VIDEO"], {
  aryeo: { photos: 40, videos: 0, floorPlans: 0, interactive: 0, delivery: null, cover: null, at: nowIso() },
  dropbox: { rawPhotos: 220, rawVideo: 0, finalPhotos: 40, finalVideo: 0, at: nowIso() },
  units: [{ category: "VIDEO", owed: 1, withClient: 0, finished: 0, source: "outputs", outstandingKeys: ["dlv1:1"] }],
}));
const blob2 = JSON.stringify(r2.evidence);
check("a never-made video blocks", outstandingForDelivery(blob2).categories.includes("Video"), "");
check(
  "and no approved cut can talk it down any more",
  // The old signature took a `provenLanded` list. It is gone, so the only way
  // to change this answer is to change the evidence.
  outstandingForDelivery.length === 1,
  `arity ${outstandingForDelivery.length}`,
);

// Finished and unsent, no unit tally at all (a blob written before Sep 18).
const awaitingOnly = JSON.stringify({ expected: ["Video"], present: ["Video"], missing: [], awaitingSend: ["Video"], units: [] });
check(
  "finished-not-sent blocks with no tally to lean on",
  outstandingForDelivery(awaitingOnly).categories.includes("Video"),
  outstandingMessage(outstandingForDelivery(awaitingOnly)),
);

// ARYEO DID NOT ANSWER. Dropbox read fine, four cuts in Final, nothing named.
// The engine suppresses awaitingSend here on purpose, so the gate must not
// invent an obligation out of `outstanding = owed - 0`, and nothing may claim
// a listing fact.
const r3 = computeStatus(sig(["VIDEO"], {
  aryeo: null,
  dropbox: { rawPhotos: 0, rawVideo: 9, finalPhotos: 0, finalVideo: 4, at: nowIso() },
  fulfilled: true,
  units: [{ category: "VIDEO", owed: 4, withClient: 0, finished: 4, source: "outputs", outstandingKeys: [] }],
}));
const blob3 = JSON.stringify(r3.evidence);
const gate3 = outstandingForDelivery(blob3);
console.log(`  aryeo read failed     : engine=${r3.status} missing=${JSON.stringify(parseEvidence(blob3)?.missing)} awaiting=${JSON.stringify(parseEvidence(blob3)?.awaitingSend)} gate=${JSON.stringify(gate3.categories)}`);
check("a failed listing read is not an obligation", gate3.categories.length === 0, JSON.stringify(gate3.categories));
check("and it prints no count off a read nobody got", owedNow(parseEvidence(blob3)).shortfall.length === 0, "");

// A PERSON IS ON RECORD for the delivery (the Sep 16 Kyle call). One video on
// the listing, four owed: the engine empties awaitingSend, and the gate must
// not refuse over a human's confirmation.
const r4 = computeStatus(sig(["VIDEO"], {
  aryeo: { photos: 0, videos: 1, floorPlans: 0, interactive: 0, delivery: null, cover: null, at: nowIso() },
  dropbox: { rawPhotos: 0, rawVideo: 9, finalPhotos: 0, finalVideo: 4, at: nowIso() },
  fulfilled: true, officeConfirmed: true, deliveredBy: "Kyle", deliveredVia: "office-hand",
  units: [{ category: "VIDEO", owed: 4, withClient: 1, finished: 4, source: "outputs", outstandingKeys: [] }],
}));
const gate4 = outstandingForDelivery(JSON.stringify(r4.evidence));
console.log(`  office hand delivery  : engine=${r4.status} gate=${JSON.stringify(gate4.categories)}`);
check("a witnessed hand delivery is not refused", gate4.categories.length === 0, JSON.stringify(gate4.categories));

// The settled end has to stay settled, or every clean job is refused.
const clean = JSON.stringify({
  expected: ["Photos", "Video"], present: ["Photos", "Video"], missing: [], awaitingSend: [],
  aryeo: { photos: 40, videos: 1, floorPlans: 0, interactive: 0, delivery: "DELIVERED" },
  units: [{ category: "Video", owed: 1, withClient: 1, finished: 1, outstanding: 0, source: "outputs" }],
});
check("a genuinely delivered job is not refused", outstandingForDelivery(clean).categories.length === 0, "");
check("no evidence blocks nothing (manual jobs)", outstandingForDelivery(null).categories.length === 0, "");
check("unparseable evidence blocks nothing", outstandingForDelivery("{not json").categories.length === 0, "");

// The office closing a hand-delivered revision keeps the never-made half.
const mixed = JSON.stringify({
  expected: ["Photos", "Video"], present: ["Video"], missing: ["Photos"], awaitingSend: ["Video"],
  aryeo: { photos: 0, videos: 0, floorPlans: 0, interactive: 0, delivery: null },
  units: [{ category: "Video", owed: 4, withClient: 0, finished: 4, outstanding: 4, source: "outputs" }],
});
const narrowed = neverMadeOnly(outstandingForDelivery(mixed));
console.log(`  office narrowing      : ${JSON.stringify(outstandingForDelivery(mixed).categories)} -> ${JSON.stringify(narrowed.categories)}`);
check("the office's word drops the owed send", !narrowed.categories.includes("Video"), "");
check("and never conjures the photos nobody shot", narrowed.categories.includes("Photos"), "");

// Plurals come off the engine's own map, not an appended letter.
const photoShort = JSON.stringify({
  expected: ["Photos"], present: [], missing: ["Photos"], awaitingSend: [],
  aryeo: { photos: 1, videos: 0, floorPlans: 0, interactive: 0, delivery: null },
  units: [{ category: "Photos", owed: 4, withClient: 1, finished: 1, outstanding: 3, source: "outputs" }],
});
const photoPhrase = owedPhrase(outstandingForDelivery(photoShort));
console.log(`  photo phrase          : ${photoPhrase}`);
check("no 'photoss'", !/photoss/.test(photoPhrase), photoPhrase);
check("the photo lane reads as photo sets", /3 of 4 photo sets/.test(photoPhrase), photoPhrase);

// ---------------------------------------------------------------------------
// PART 4 — the client-facing copy on the same blob. It must not read a
// delivery back to a client who has received nothing (5642 Limeport Rd).
// ---------------------------------------------------------------------------
console.log("\nPART 4 — the text the client would get");
const videoOnly = JSON.stringify({
  expected: ["Video"], present: ["Video"], missing: [], awaitingSend: ["Video"],
  aryeo: { photos: 0, videos: 0, floorPlans: 0, interactive: 0, delivery: null },
  units: [{ category: "Video", owed: 4, withClient: 0, finished: 4, outstanding: 4, source: "outputs" }],
});
const text = deliveryMessage({ id: "p1", title: "5642 Limeport Rd, Emmaus", statusEvidence: videoOnly, client: { name: "Gary Smith" } });
console.log(`  ${text}`);
check("it claims no delivery", !/delivered/i.test(text), text);
check("it carries the count", /4 of 4 videos/.test(text), text);
check("it does not call finished work unmade", !/in production/i.test(text), text);
check("it says the way forward", /let you know/i.test(text), text);
check("no em dash in client copy", !text.includes("—"), text);

const mixedText = deliveryMessage({
  id: "p2", title: "1 Main St, West Chester",
  statusEvidence: JSON.stringify({
    expected: ["Photos", "Video"], present: ["Photos", "Video"], missing: [], awaitingSend: ["Video"],
    aryeo: { photos: 40, videos: 0, floorPlans: 0, interactive: 0, delivery: null },
    units: [{ category: "Video", owed: 4, withClient: 0, finished: 4, outstanding: 4, source: "outputs" }],
  }),
  client: { name: "Gary Smith" },
});
console.log(`  ${mixedText}`);
check("photos out, video not: the photos are still announced", /photos/i.test(mixedText) && /delivered/i.test(mixedText), mixedText);
check("and the video half is not called production", !/in production/i.test(mixedText), mixedText);

// ---------------------------------------------------------------------------
// PART 3 — live production, READ ONLY. Every project carrying evidence: does
// the gate still pass on a job its own blob says is owed?
// ---------------------------------------------------------------------------
async function live() {
  console.log("\nPART 3 — live production (read-only SELECT)");
  const { prisma } = await import("../../src/lib/prisma");
  const rows = await prisma.project.findMany({
    where: { statusEvidence: { not: null } },
    select: { id: true, title: true, status: true, statusEvidence: true },
  });
  let divergent = 0;
  let blocked = 0;
  let head = 0;
  let shortfallOnly = 0;
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  for (const p of rows) {
    const ev = parseEvidence(p.statusEvidence);
    const owed = owedNow(ev);
    const gate = outstandingForDelivery(p.statusEvidence);
    if (gate.categories.length > 0) blocked++;
    if ((ev?.missing.length ?? 0) > 0) head++;
    // The decision this fix rests on: is a unit shortfall ever news the two
    // lists do not already carry?
    for (const u of ev?.units ?? []) {
      if (Math.max(0, u.outstanding ?? 0) > 0 && ![...(ev?.missing ?? []), ...(ev?.awaitingSend ?? [])].some((c) => same(c, u.category))) {
        shortfallOnly++;
        console.log(`  SHORTFALL-ONLY  ${p.title} (${p.status}) ${u.category} ${u.outstanding}/${u.owed}`);
      }
    }
    if (owed.categories.length > 0 && gate.categories.length === 0) {
      divergent++;
      console.log(`  DIVERGENT  ${p.title} (${p.status}) owed=${JSON.stringify(owed.categories)}`);
    }
  }
  console.log(`  projects with evidence           : ${rows.length}`);
  console.log(`  the old 'missing'-only gate blocked: ${head}`);
  console.log(`  this gate blocks                  : ${blocked}`);
  console.log(`  shortfall categories neither list carries: ${shortfallOnly}`);
  check("no job passes the gate while work is owed", divergent === 0, `${divergent} divergent`);
  check("the gate never blocks less than it used to", blocked >= head, `${blocked} vs ${head}`);
  check("a unit shortfall is never news on live data", shortfallOnly === 0, `${shortfallOnly}`);

  for (const title of ["5 Raymond Cir", "453 Cardigan", "5642 Limeport"]) {
    const p = rows.find((r) => r.title.includes(title));
    if (!p) { console.log(`  (not found: ${title})`); continue; }
    const gate = outstandingForDelivery(p.statusEvidence);
    console.log(`  ${p.title}: ${outstandingMessage(gate)}`);
    check(`${title} is refused`, gate.categories.length > 0, "");
  }
  await prisma.$disconnect();
}

live()
  .catch((e) => { failures++; console.error(e); })
  .finally(() => {
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  });
