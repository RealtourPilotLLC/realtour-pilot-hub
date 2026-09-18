/**
 * R02 (reopened Sep 18) — the whole chain, end to end:
 *
 *     computeStatus  →  JSON.stringify  →  parseEvidence  →  evidenceTone
 *
 * That is the path a project page actually takes, and it is where the
 * contradiction lived: the engine counted three outstanding videos, the parser
 * threw the count away, and the headline said everything was confirmed.
 *
 *   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_drill/r02-headline.ts
 *
 * Pure: no database, no network.
 */
import { computeStatus, type StatusSignals, type MediaCategory } from "../../src/lib/projectStatus";
import { parseEvidence, evidenceTone, statusFlag } from "../../src/lib/statusEvidence";

const DAY = 86_400_000;
const shot = new Date(Date.now() - 6 * DAY);

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
const aryeo = (videos: number, photos = 0, delivery: string | null = "DELIVERED") => ({
  photos, videos, floorPlans: 0, interactive: 0, delivery, cover: null,
  at: new Date().toISOString(),
});
const dbx = (finalVideo: number, finalPhotos = 0) => ({
  rawPhotos: 120, rawVideo: 8, finalPhotos, finalVideo, at: new Date().toISOString(),
});
/** owed / named-deliveries / finished — `named` is the per-video deliveredAt count. */
const videoUnits = (owed: number, named: number, finished: number) => [{
  category: "VIDEO", owed, withClient: named, finished, source: "outputs",
  outstandingKeys: Array.from({ length: Math.max(0, owed - named) }, (_, i) => `dlv1:${named + i + 1}`),
}];

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail: string) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}\n        ${detail}`);
}

/** Walk the real chain and hand back what a reader would actually see. */
function seen(s: StatusSignals, status?: string) {
  const r = computeStatus(s);
  const blob = JSON.stringify(r.evidence);
  const e = parseEvidence(blob)!;
  const tone = evidenceTone({ status: status ?? r.status, evidence: e, succeededAt: new Date() });
  const flag = statusFlag(status ?? r.status, blob, { succeededAt: new Date() });
  return { status: r.status, reason: r.evidence.reason, e, tone, flag };
}

console.log("=".repeat(76));
console.log("R02 — does the headline agree with the engine that wrote it?");
console.log("=".repeat(76));

console.log("\n1. THE REVIEWER'S REPRODUCTION — 4 owed, 1 on the listing, 4 finished");
{
  const v = seen(sig(["VIDEO"], { aryeo: aryeo(1), dropbox: dbx(4), fulfilled: true, units: videoUnits(4, 1, 4) }));
  check("the parser keeps the count", v.e.units.length === 1 && v.e.units[0].owed === 4,
    `units = ${JSON.stringify(v.e.units)}`);
  check("the headline is NOT an all-clear", v.tone.kind !== "clear",
    `${v.tone.kind} — "${v.tone.headline}"`);
  check("the reader is told what is owed", /outstanding|Video/i.test(v.tone.headline + " " + (v.tone.detail ?? "")),
    `detail: ${v.tone.detail}`);
  check("the chip says so too", !!v.flag && v.flag.kind !== "ready", `flag = ${JSON.stringify(v.flag)}`);
}

console.log("\n2. FOUR LISTING ENTRIES, ONE NAMED — repeated versions look like four videos");
{
  // LIVE job: the listing carries four and nobody has confirmed a delivery, so
  // this is the case where somebody can still go and look before it goes out.
  const v = seen(sig(["VIDEO"], { aryeo: aryeo(4, 0, null), dropbox: dbx(4), units: videoUnits(4, 1, 4) }));
  check("the count is not claimed as an identification", v.tone.kind === "unmatched",
    `${v.tone.kind} — "${v.tone.headline}"`);
  check("it names both numbers", /4 videos against 4 ordered/.test(v.tone.detail ?? "") && /only 1 of them/.test(v.tone.detail ?? ""),
    `${v.tone.detail}`);
  check("every unstamped output stays unresolved (no positional trimming)",
    (v.e.units[0].unresolvedKeys ?? []).length === 3,
    `unresolvedKeys = ${JSON.stringify(v.e.units[0].unresolvedKeys)}`);
  check("unmatched is reported as a number, not attributed to a slot", v.e.units[0].unmatched === 3,
    `unmatched = ${v.e.units[0].unmatched}, named = ${v.e.units[0].named}, onListing = ${v.e.units[0].onListing}`);
}

console.log("\n3. FOUR NAMED DELIVERIES — this one really is finished");
{
  const v = seen(sig(["VIDEO"], { aryeo: aryeo(4), dropbox: dbx(4), fulfilled: true, units: videoUnits(4, 4, 4) }));
  check("a genuinely complete job still reads clear", v.tone.kind === "clear",
    `${v.tone.kind} — "${v.tone.headline}"`);
}

console.log("\n4. A DELIVERED JOB IS NOT ACCUSED — quiet, but still not an all-clear");
{
  const v = seen(sig(["VIDEO"], { aryeo: aryeo(4), dropbox: dbx(4), fulfilled: true, units: videoUnits(4, 1, 4) }), "DELIVERED");
  check("no amber on an old delivery", v.tone.kind === "unconfirmed", `${v.tone.kind} — "${v.tone.headline}"`);
  check("but it does not say everything is confirmed", v.tone.kind !== "clear", `"${v.tone.headline}"`);
}

console.log("\n5. MIXED PHOTO / VIDEO — photos out, one video of four out");
{
  const v = seen(sig(["PHOTOS", "VIDEO"], { aryeo: aryeo(1, 42), dropbox: dbx(4, 42), fulfilled: true, units: videoUnits(4, 1, 4) }));
  check("photos being done does not finish the job", v.tone.kind !== "clear", `${v.tone.kind} — "${v.tone.headline}"`);
}

console.log("\n6. MADE AND NEVER SENT — nothing missing, everything owed");
{
  const v = seen(sig(["VIDEO"], { aryeo: aryeo(0), dropbox: dbx(1), units: videoUnits(1, 0, 1) }));
  check("an empty `missing` does not mean finished", v.tone.kind !== "clear", `${v.tone.kind} — "${v.tone.headline}"`);
  check("the owed send is named in the tone", v.tone.awaitingSend.length === 1, `awaitingSend = ${JSON.stringify(v.tone.awaitingSend)}`);
}

console.log("\n7. STALE EVIDENCE STILL OUTRANKS EVERYTHING");
{
  const r = computeStatus(sig(["VIDEO"], { aryeo: aryeo(1), dropbox: dbx(4), fulfilled: true, units: videoUnits(4, 1, 4) }));
  const e = parseEvidence(JSON.stringify(r.evidence))!;
  const tone = evidenceTone({ status: r.status, evidence: e, error: "too_many_requests" });
  check("a failed read is reported as a failed read, not as a verdict", tone.kind === "unknown",
    `${tone.kind} — "${tone.headline}"`);
}

console.log(`\n${fail === 0 ? `ALL CHECKS PASSED (${pass} passed)` : `${fail} FAILED, ${pass} passed`}`);
process.exit(fail === 0 ? 0 : 1);
