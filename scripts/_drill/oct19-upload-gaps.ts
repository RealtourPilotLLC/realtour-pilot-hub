// ---------------------------------------------------------------------------
// DRILL: WHAT THE UPLOAD IS MISSING (Oct 19 2026, lib/uploadGaps). Jordan:
// "if anything is missing from the upload, the creative gets a text. Has to be
// sure though. Like today, it looks like Harrison only uploaded drone photos
// to Dropbox for his shoots."
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct19-upload-gaps.ts
//
// Pure: the counting, the "sure" rules, the words. No database, no Dropbox,
// nothing sent. The live dry run on Oct 19 (read-only) flagged exactly 34
// Oakland Rd and 104 Carlton Ct, both drone-only, and nothing else.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const REPO = path.resolve(__dirname, "..", "..");

async function main() {
  const c = makeChecker();
  const { countUpload, readGaps, composeGapText, heldWords, uploadGapKey } = await import("../../src/lib/uploadGaps");

  const t0 = new Date("2026-10-19T13:00:00Z"); // shoot start, 9 AM ET
  const at = (h: number) => new Date(t0.getTime() + h * 3_600_000);
  const iso = (d: Date) => d.toISOString();
  const dji = (n: number, when: Date) => Array.from({ length: n }, (_, i) => ({ name: `DJI_20261019_${i}_D.DNG`, path: `/x/01-RAW-Photos/DJI_${i}.DNG`, serverModified: iso(when) }));
  const brackets = (n: number, when: Date) => Array.from({ length: n }, (_, i) => ({ name: `_DSC${1000 + i}.ARW`, path: `/x/01-RAW-Photos/_DSC${1000 + i}.ARW`, serverModified: iso(when) }));
  const clips = (n: number, when: Date, folder = "Wide/Kitchen") => Array.from({ length: n }, (_, i) => ({ name: `C${i}.MP4`, path: `/x/02-RAW-Video/${folder}/C${i}.MP4`, serverModified: iso(when) }));
  const all = { photos: true, drone: true, video: false };

  c.head("1 · counting what came in");
  const k = countUpload([...dji(45, at(12)), ...brackets(10, at(12))], [...clips(4, at(12), "Drone"), ...clips(3, at(12))]);
  c.ok("DJI names and a Drone folder are drone; the rest of the images are ground photos; the rest of the clips are footage",
    k.dronePhotos === 45 && k.groundPhotos === 10 && k.droneClips === 4 && k.footage === 3, JSON.stringify(k));
  c.ok("…and a stray sidecar file is not a photo", countUpload([{ name: "notes.txt" }, { name: "DJI_1.JPG" }], []).dronePhotos === 1 && countUpload([{ name: "notes.txt" }], []).groundPhotos === 0);

  c.head("2 · sure, not early (the Harrison case)");
  const droneOnly = countUpload(dji(33, at(12)), []);
  const r1 = readGaps({ ordered: all, counts: droneOnly, startAt: t0, now: at(13.1), photosHandoffAt: null, videoHandoffAt: null });
  c.ok("drone photos in, not one ground photo, quiet for an hour: the ground photos are missing (sure)", r1.sure.join() === "ground_photos", JSON.stringify(r1));
  const r2 = readGaps({ ordered: all, counts: droneOnly, startAt: t0, now: at(12.5), photosHandoffAt: null, videoHandoffAt: null });
  c.ok("…but only 30 minutes after the last file landed: still uploading, nothing sent", r2.sure.length === 0 && r2.waiting === "still uploading", JSON.stringify(r2));
  const r3 = readGaps({ ordered: all, counts: countUpload(dji(5, at(0.5)), []), startAt: t0, now: at(1.5), photosHandoffAt: null, videoHandoffAt: null });
  c.ok("…and never within two hours of the shoot's start", r3.sure.length === 0 && r3.waiting === "the shoot only just started", JSON.stringify(r3));
  const r4 = readGaps({ ordered: all, counts: countUpload([...dji(33, at(5)), ...brackets(150, at(5))], []), startAt: t0, now: at(8), photosHandoffAt: null, videoHandoffAt: null });
  c.ok("ground photos and drone both in: nothing missing", r4.sure.length === 0 && r4.alsoEmpty.length === 0, JSON.stringify(r4));
  const r5 = readGaps({ ordered: all, counts: countUpload([], []), startAt: t0, now: at(10), photosHandoffAt: null, videoHandoffAt: null });
  c.ok("nothing uploaded at all: not this check's (the evening chaser asks for the upload page)", r5.sure.length === 0 && r5.waiting === "nothing uploaded yet", JSON.stringify(r5));

  c.head("3 · drone and footage only once the creative hands that half in");
  const groundOnly = countUpload(brackets(150, at(5)), []);
  const r6 = readGaps({ ordered: all, counts: groundOnly, startAt: t0, now: at(9), photosHandoffAt: null, videoHandoffAt: null });
  c.ok("ground photos in, no drone yet, not handed in: drone is NOT called missing (it often comes hours later)", r6.sure.length === 0 && r6.alsoEmpty.join() === "drone", JSON.stringify(r6));
  const r7 = readGaps({ ordered: all, counts: groundOnly, startAt: t0, now: at(9), photosHandoffAt: at(8.5), videoHandoffAt: null });
  c.ok("…handed in on the upload page 30 minutes ago with not one drone file: drone is missing (sure)", r7.sure.join() === "drone", JSON.stringify(r7));
  const vid = { photos: true, drone: false, video: true };
  const r8 = readGaps({ ordered: vid, counts: groundOnly, startAt: t0, now: at(9), photosHandoffAt: at(6), videoHandoffAt: null });
  c.ok("a video job, photos in, no footage, video half not handed in: footage NOT called missing (it often comes days later)", r8.sure.length === 0 && r8.alsoEmpty.join() === "footage", JSON.stringify(r8));
  const r9 = readGaps({ ordered: vid, counts: groundOnly, startAt: t0, now: at(9), photosHandoffAt: at(6), videoHandoffAt: at(8.5) });
  c.ok("…the video half handed in with not one clip: the footage is missing (sure)", r9.sure.join() === "footage", JSON.stringify(r9));
  const r10 = readGaps({ ordered: { photos: true, drone: false, video: false }, counts: countUpload(brackets(100, at(5)), []), startAt: t0, now: at(9), photosHandoffAt: at(6), videoHandoffAt: null });
  c.ok("a photos-only job with its photos in: nothing", r10.sure.length === 0 && r10.alsoEmpty.length === 0, JSON.stringify(r10));

  c.head("4 · the text");
  const text = composeGapText({ firstName: "Harrison", street: "34 Oakland Rd", shotWhen: "today", counts: countUpload(dji(45, at(12)), clips(4, at(12), "Drone")), sure: ["ground_photos"], alsoEmpty: ["footage"], link: "https://hub.realtourpilot.com/upload/p1" });
  c.ok("says what Dropbox has, what is missing, what else is not there yet, and links the upload page",
    /Dropbox only has 45 drone photos and 4 drone clips/.test(text) && /Missing: the ground photos\./.test(text) && /Also not there yet: the video footage\./.test(text) && /Upload page: https:\/\/hub\.realtourpilot\.com\/upload\/p1$/.test(text), text);
  c.ok("no dashes, no dollar figures", !/[–—]/.test(text) && !/\$\d/.test(text), text);
  c.ok("held words read naturally", heldWords(countUpload(dji(1, at(1)), [])) === "1 drone photo" && heldWords(countUpload([], [])) === "nothing");
  c.ok("one text per job, person and gap (the outbox key)", uploadGapKey("p1", "tm1", ["footage", "ground_photos"]) === "upload_gap:p1:tm1:footage+ground_photos");

  c.head("5 · wired in");
  const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
  c.ok("the photo delivery gate carries 'Everything ordered was uploaded'", /uploadCheck\(job\.projectId\)/.test(src("src/lib/photoDelivery/delivery.ts")) && /Everything ordered was uploaded/.test(src("src/lib/photoDelivery/delivery.ts")));
  c.ok("the 5-minute cron runs the sweep, and the outbox drain answers the switch", /step\("uploadGaps"/.test(src("src/app/api/cron/gmail/route.ts")) && /kind === "upload_gap"/.test(src("src/app/api/cron/gmail/route.ts")));
  c.ok("its own Settings switch, on by default", /uploadGap: \{ enabled: true \}/.test(src("src/lib/settings.ts")) && /Missing from the upload/.test(src("src/components/settings/OperatingRules.tsx")));

  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
