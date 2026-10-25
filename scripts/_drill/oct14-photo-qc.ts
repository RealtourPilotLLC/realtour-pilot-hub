// ---------------------------------------------------------------------------
// DRILL: THE PHOTO QC BUILDING BLOCKS THE FREE CHECK STILL USES (Photo
// Delivery, Oct 13-14 2026; trimmed Oct 25 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct14-photo-qc.ts
//
// Paid photo QC is off for good (Jordan, Oct 23 2026: "Paid Photo QC should
// be off. Only using the free version.") and its engine was deleted (audit Oct
// 25 2026, D7): qc/run.ts, qc/claude.ts, qc/cost.ts, qc/normalize.ts, the
// prompt pack and qc/index.ts. The sections that exercised only that engine
// (the verbatim prompts, the deterministic repairs, box math and the dust
// merge, runPass, the end-to-end run) went with it. What is left:
//    1. registry filtering per room; the <rules> block is deterministic
//    5. verdicts: every branch, the privacy floor, the low-confidence floor,
//       overrides, escalation; grouping across photos; delivery order, hero
//       and filenames
//    6. CV on synthetic images: sharp vs blurred, dust on a flat wall, a
//       near-duplicate pair, a preview-sized file, a truncated file, repeated
//       dust clustering; the timing on a 6000x4000 photo
//    8. the source dispatch: Aryeo host allowlist, AutoHDR unsupported
//    9. the paid QC is off: the stored switches read off, the engine files
//       are gone, the photo-qc lane runs only the free check and the fix
//       planning, a changed gallery raises no paid request
//   10. the provider fence stayed closed.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import type { FindingLike, OrderPhoto } from "@/lib/photoDelivery/qc/verdict";

const PORT = Number(process.env.DRILL_PORT ?? 6714);
const REPO = path.resolve(__dirname, "../..");

installNextStubs();
const fence = fenceFetch();

// ---- synthetic images ---------------------------------------------------------------
function rnd(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
async function textured(W: number, H: number, seed: number, vertical: boolean): Promise<Buffer> {
  const r = rnd(seed);
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = vertical ? y / H : x / W;
      const base = 60 + 140 * t + (Math.floor(x / 250) % 2) * 25;
      const n = (r() - 0.5) * 70;
      const i = (y * W + x) * 3;
      buf[i] = Math.max(0, Math.min(255, base + n + (seed % 3) * 10));
      buf[i + 1] = Math.max(0, Math.min(255, base + n));
      buf[i + 2] = Math.max(0, Math.min(255, base + n - (seed % 5) * 6));
    }
  }
  return sharp(buf, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

async function main() {
  const db = await bootDrillDb({ port: PORT });
  const c = makeChecker();
  try {
    const R = await import("@/lib/photoDelivery/registry");
    const V = await import("@/lib/photoDelivery/qc/verdict");
    const D = await import("@/lib/photoDelivery/qc/derivatives");
    const CV = await import("@/lib/photoDelivery/qc/cv");
    const S = await import("@/lib/photoDelivery/qc/source");

    // ---- 1. registry, rules block --------------------------------------------------------
    c.head("1 · registry filtering, the rules block");
    const bath = R.visionRulesForPhoto({ roomType: "BATHROOM", roomConfidence: 0.95, alternateRoomType: null, maxBuildPhase: 1 });
    const kitchen = R.visionRulesForPhoto({ roomType: "KITCHEN", roomConfidence: 0.95, alternateRoomType: null, maxBuildPhase: 1 });
    const front = R.visionRulesForPhoto({ roomType: "EXTERIOR_FRONT", roomConfidence: 0.95, alternateRoomType: null, maxBuildPhase: 1 });
    c.ok(`the registry loads every rule (${R.RULES.length}, ${R.RULES_REGISTRY_VERSION})`, R.RULES.length >= 425 && /^v1/.test(R.RULES_REGISTRY_VERSION));
    c.ok("a bathroom gets the toilet-seat rule, a kitchen does not", bath.some((r) => r.id === "BATH_TOILET_SEAT_OPEN") && !kitchen.some((r) => r.id === "BATH_TOILET_SEAT_OPEN"));
    c.ok("a kitchen gets the sink-clutter rule, a bathroom does not", kitchen.some((r) => r.id === "KIT_DISH_SOAP_SPONGES") && !bath.some((r) => r.id === "KIT_DISH_SOAP_SPONGES"));
    c.ok("a front exterior gets the hose rule and no room clutter rules", front.some((r) => r.id === "EXT_GARDEN_HOSES") && !front.some((r) => r.id.startsWith("BATH_") || r.id.startsWith("KIT_")));
    c.ok("only P1 vision rules are injected (no gallery, order or pure file rules)", [...bath, ...kitchen, ...front].every((r) => r.pass === "P1_PHOTO" && (r.detector === "VISION_PHOTO" || r.secondaryDetector === "VISION_PHOTO")));
    const unsure = R.visionRulesForPhoto({ roomType: "BATHROOM", roomConfidence: 0.5, alternateRoomType: "KITCHEN", maxBuildPhase: 1 });
    c.ok("an unsure label (confidence < 0.6) injects both rooms' rules", unsure.some((r) => r.id === "BATH_TOILET_SEAT_OPEN") && unsure.some((r) => r.id === "KIT_DISH_SOAP_SPONGES"));
    const phase3 = R.visionRulesForPhoto({ roomType: "BATHROOM", roomConfidence: 0.95, alternateRoomType: null, maxBuildPhase: 3 });
    c.ok("phase 1 is a subset of phase 3, and CRITICAL-capable rules run at phase 1", phase3.length > bath.length && bath.every((r) => r.buildPhase === 1 || R.canBeCritical(r)));
    const blockA = R.renderRulesBlock(bath, `room_type="BATHROOM"`);
    const blockB = R.renderRulesBlock([...bath].reverse(), `room_type="BATHROOM"`);
    c.ok("the rules block is identical whatever the input order (cache prefix stable)", blockA === blockB && !/\d{4}-\d{2}-\d{2}T/.test(blockA));
    const lines = blockA.split("\n").slice(1, -2).map((l) => JSON.parse(l).id as string);
    c.ok("the block is sorted by id and ends with the OTHER_DEFECT line", lines.join() === [...lines].sort().join() && blockA.endsWith("Any severity, any fixStrategy."));

    // ---- 5. verdicts, grouping, order -----------------------------------------------------
    c.head("5 · verdicts (every branch), grouping across photos, delivery order and filenames");
    let n = 0;
    const F = (o: Partial<FindingLike> & { ruleId?: string }) => ({ id: `f${++n}`, ruleId: "KIT_DISH_SOAP_SPONGES", groupKey: `k${n}`, photoId: "pa", severity: "MAJOR", confidence: 0.9, status: "OPEN", arbitration: "NOT_REQUIRED", privacySensitive: false, ...o }) as FindingLike;
    c.ok("nothing → PASS", V.jobVerdict([]).verdict === "PASS");
    c.ok("only MINOR → PASS_WITH_MINOR", V.jobVerdict([F({ severity: "MINOR" })]).verdict === "PASS_WITH_MINOR");
    c.ok("an open MAJOR → NEEDS_DECISION", V.jobVerdict([F({}), F({ severity: "MINOR" })]).verdict === "NEEDS_DECISION");
    c.ok("an unresolved CRITICAL, arbitration NOT_REQUIRED → HOLD", V.jobVerdict([F({ severity: "CRITICAL" })]).verdict === "HOLD");
    c.ok("an unresolved CRITICAL still PENDING the arbiter → HOLD", V.jobVerdict([F({ severity: "CRITICAL", arbitration: "PENDING" })]).verdict === "HOLD");
    c.ok("a CONFIRMED CRITICAL → HOLD", V.jobVerdict([F({ severity: "CRITICAL", arbitration: "CONFIRMED" })]).verdict === "HOLD");
    c.ok("an OVERTURNED row still carrying CRITICAL does not hold (needs a decision)", V.jobVerdict([F({ severity: "CRITICAL", arbitration: "OVERTURNED" })]).verdict === "NEEDS_DECISION");
    c.ok("the privacy floor holds at read time too (a MINOR privacy row counts as MAJOR)", V.effectiveSeverity({ ruleId: "PREP_PERSONAL_DOCUMENTS", severity: "MINOR", privacySensitive: true }) === "MAJOR");
    const low = V.jobVerdict([F({ severity: "CRITICAL", confidence: 0.3 })], { floor: 0.5 });
    c.ok("below the display floor: the low-confidence drawer, never blocking", low.verdict === "PASS" && low.lowConfidence.length === 1 && low.counts.lowConfidence === 1);
    c.ok("a calibrated per-rule cutoff is honoured", V.jobVerdict([F({ confidence: 0.7 })], { floor: 0.5, ruleFloors: { KIT_DISH_SOAP_SPONGES: 0.8 } }).verdict === "PASS");
    c.ok("a person's decision resolves it (IGNORED, SENT_TO_EDITOR), APPROVED_FIX does not", V.jobVerdict([F({ status: "IGNORED", severity: "CRITICAL" }), F({ status: "SENT_TO_EDITOR" })]).verdict === "PASS" && V.jobVerdict([F({ status: "APPROVED_FIX" })]).verdict === "NEEDS_DECISION");
    c.ok("SUPERSEDED rows are history", V.jobVerdict([F({ status: "SUPERSEDED", severity: "CRITICAL" })]).verdict === "PASS");
    c.ok("findings only about excluded photos drop out", V.jobVerdict([F({ photoId: "px", severity: "CRITICAL" })], { excludedPhotoIds: ["px"] }).verdict === "PASS");
    c.ok("client override applies last (a MAJOR rule re-graded MINOR)", V.jobVerdict([F({})], { overrides: [{ ruleId: "KIT_DISH_SOAP_SPONGES", severity: "MINOR", reason: "client is fine with it" }] }).verdict === "PASS_WITH_MINOR");
    c.ok("client override can make a rule hold (MAJOR re-graded CRITICAL)", V.jobVerdict([F({})], { overrides: [{ ruleId: "KIT_DISH_SOAP_SPONGES", severity: "CRITICAL", reason: "hero rule" }] }).verdict === "HOLD");
    const g3 = V.groupFindings(["p1", "p2", "p3"].map((photoId) => F({ ruleId: "BATH_TOILET_SEAT_OPEN", groupKey: "toilet-lid-open-hall-bath", photoId })));
    c.ok("same ruleId + groupKey in 3 photos = ONE ticket listing all 3", g3.groups.length === 1 && g3.groups[0].photoIds.length === 3 && /3 photos/.test(g3.groups[0].title));
    const spotGroup = V.jobVerdict(["p1", "p2", "p3"].map((photoId) => F({ ruleId: "REFL_SENSOR_DUST", groupKey: "sensor-dust-repeated-rg1", photoId })));
    c.ok("the registry's escalation: the same dust spot in 3 photos → CRITICAL → HOLD", spotGroup.verdict === "HOLD" && spotGroup.groups[0].escalated);
    const scattered = V.jobVerdict(["p1", "p2", "p3"].map((photoId) => F({ ruleId: "REFL_SENSOR_DUST", groupKey: "sensor-dust", photoId })));
    c.ok("dust at DIFFERENT spots in 3 photos is one MAJOR ticket, not escalated", scattered.verdict === "NEEDS_DECISION" && !scattered.groups[0].escalated);
    const pv2 = V.photoVerdicts([F({ photoId: "pa", severity: "CRITICAL" }), F({ photoId: "pb", severity: "MINOR" })], ["pa", "pb", "pc"]);
    c.ok("per-photo verdicts: HOLD / PASS_WITH_MINOR / PASS", pv2.pa === "HOLD" && pv2.pb === "PASS_WITH_MINOR" && pv2.pc === "PASS");
    c.ok("shadow mode never holds: MAJOR+ → QC_REVIEW, else READY", V.qcStageFor({ verdict: "HOLD", hasMajorPlus: true }, true) === "QC_REVIEW" && V.qcStageFor({ verdict: "PASS_WITH_MINOR", hasMajorPlus: false }, true) === "READY");
    c.ok("live mode: HOLD → ON_HOLD, NEEDS_DECISION → QC_REVIEW, PASS → READY", V.qcStageFor({ verdict: "HOLD", hasMajorPlus: true }, false) === "ON_HOLD" && V.qcStageFor({ verdict: "NEEDS_DECISION", hasMajorPlus: true }, false) === "QC_REVIEW" && V.qcStageFor({ verdict: "PASS", hasMajorPlus: false }, false) === "READY");
    const O = (id: string, sequence: number, roomType: string, o: Partial<OrderPhoto> = {}) => ({ id, name: `${id}.jpg`, sequence, status: "ACTIVE", roomType, sequenceGroup: null, heroScore: 50, ...o });
    const gallery = [
      O("bath2", 1, "BATHROOM"), O("kit2", 2, "KITCHEN"), O("front1", 3, "EXTERIOR_FRONT", { heroScore: 70 }), O("kit1", 4, "KITCHEN"),
      O("front2", 5, "EXTERIOR_FRONT", { heroScore: 91 }), O("aerial", 6, "AERIAL"), O("gone", 7, "KITCHEN", { status: "EXCLUDED" }), O("living", 8, "LIVING"), O("mystery", 9, ""),
    ];
    const ord = V.deliveryOrder(gallery);
    c.ok("hero = the best front exterior by hero score when there is no twilight", ord.heroId === "front2" && ord.order[0].id === "front2");
    c.ok("then the sequence groups in order; AutoHDR order inside a group; excluded out; unclassified last", ord.order.map((p) => p.id).join() === "front2,front1,living,kit2,kit1,bath2,aerial,mystery");
    const ordTw = V.deliveryOrder([...gallery, O("dusk", 10, "TWILIGHT_EXTERIOR", { isTwilight: true, heroScore: 60 })]);
    c.ok("a twilight frame is the hero whenever there is one", ordTw.heroId === "dusk");
    const names = V.finalFilenames(ordTw.order);
    c.ok("filenames NN-Room-Label.jpg, twilight gets -Twilight", names[0].filename === "01-Front-Exterior-Twilight.jpg" && names[1].filename === "02-Front-Exterior.jpg" && names.some((x) => x.filename === "04-Living-Room.jpg") && names[names.length - 1].filename === "09-Photo.jpg");
    const manual = V.deliveryOrder(gallery, { manualOrder: ["kit1", "front1", "gone"] });
    c.ok("a person's order wins; new photos are appended in suggested order", manual.order.slice(0, 2).map((p) => p.id).join() === "kit1,front1" && manual.order.length === 8 && !manual.order.some((p) => p.id === "gone"));

    // ---- 6. CV on synthetic images --------------------------------------------------------
    c.head("6 · deterministic CV on synthetic images");
    const analyze = async (buf: Buffer) => {
      const meta = await D.readMeta(buf);
      const raster = await D.decodeRaster(buf, meta);
      return { meta, raster, cv: await CV.analyzeRaster(raster, meta) };
    };
    const cb = Buffer.alloc(3000 * 2000 * 3);
    for (let y = 0; y < 2000; y++) for (let x = 0; x < 3000; x++) { const v = ((x >> 4) + (y >> 4)) % 2 ? 220 : 40; cb.fill(v, (y * 3000 + x) * 3, (y * 3000 + x) * 3 + 3); }
    const sharpCv = (await analyze(await sharp(cb, { raw: { width: 3000, height: 2000, channels: 3 } }).jpeg({ quality: 90 }).toBuffer())).cv;
    const softCv = (await analyze(await sharp(cb, { raw: { width: 3000, height: 2000, channels: 3 } }).blur(12).jpeg({ quality: 90 }).toBuffer())).cv;
    c.ok("a blurred copy scores far lower than the sharp checkerboard", softCv.blurScore < sharpCv.blurScore / 100, `${sharpCv.blurScore} vs ${softCv.blurScore}`);
    c.ok("severe blur (whole frame soft) is a CV finding; the sharp one is not", !!CV.severeBlurIssue(softCv) && !CV.severeBlurIssue(sharpCv));
    const wallDots = [{ x: 900, y: 700 }, { x: 3100, y: 1500 }, { x: 2000, y: 2400 }];
    const wallRaw = Buffer.alloc(4500 * 3000 * 3);
    const wr = rnd(7);
    for (let y = 0; y < 3000; y++) for (let x = 0; x < 4500; x++) {
      let v = 200 + (wr() - 0.5) * 4 + (y / 3000) * 6;
      for (const d of wallDots) { const q = ((x - d.x) ** 2 + (y - d.y) ** 2) / 98; if (q < 12) v -= 22 * Math.exp(-q); }
      wallRaw.fill(Math.round(v), (y * 4500 + x) * 3, (y * 4500 + x) * 3 + 3);
    }
    const wall = await analyze(await sharp(wallRaw, { raw: { width: 4500, height: 3000, channels: 3 } }).jpeg({ quality: 92 }).toBuffer());
    const near = wallDots.map((d) => Math.min(...wall.cv.dustCandidates.map((k) => Math.hypot(k.x - d.x, k.y - d.y))));
    c.ok("three soft dark dots on a flat wall: each found within 5 px (full resolution)", near.every((d) => d <= 5), near.map((d) => d.toFixed(1)).join(", "));
    c.ok("and nothing else on the clean wall", wall.cv.dustCandidates.length === 3, `${wall.cv.dustCandidates.length} candidates`);
    const scene = await textured(3000, 2000, 11, false);
    const twin = await sharp(scene).modulate({ brightness: 1.03 }).extract({ left: 8, top: 6, width: 2990, height: 1992 }).resize(3000, 2000).jpeg({ quality: 88 }).toBuffer();
    const other = await textured(3000, 2000, 4, true);
    const [ha, hb, ho] = [(await analyze(scene)).cv.dHash, (await analyze(twin)).cv.dHash, (await analyze(other)).cv.dHash];
    c.ok("a near-duplicate pair has a small dHash distance, an unrelated photo a large one", CV.hammingHex(ha, hb) <= 6 && CV.hammingHex(ha, ho) > 12, `${CV.hammingHex(ha, hb)} vs ${CV.hammingHex(ha, ho)}`);
    const tiny = await sharp({ create: { width: 800, height: 533, channels: 3, background: { r: 120, g: 130, b: 140 } } }).jpeg().toBuffer();
    const tinyIssues = CV.fileIssues({ meta: await D.readMeta(tiny), strictError: null, missingEoi: false, name: "IMG_0001.jpg", path: null, minLongEdgePx: 2000, metrics: null });
    c.ok("a 800 px file is a preview in place of a final (CRITICAL)", tinyIssues.some((i) => i.ruleId === "FILE_PREVIEW_NOT_FINAL" && i.severity === "CRITICAL"));
    const cut = scene.subarray(0, Math.floor(scene.length * 0.6));
    const strict = await D.strictDecode(cut);
    const cutIssues = CV.fileIssues({ meta: await D.readMeta(cut), strictError: strict.ok ? null : strict.error, missingEoi: D.jpegMissingEoi(cut), name: "a.jpg", path: null, minLongEdgePx: 2000, metrics: null });
    c.ok("a truncated JPEG fails the strict decode and is a FILE_OPENS finding", !strict.ok && D.jpegMissingEoi(cut) && cutIssues.some((i) => i.ruleId === "FILE_OPENS"));
    const png = await sharp(scene).png().toBuffer();
    c.ok("a PNG final is the wrong format", CV.fileIssues({ meta: await D.readMeta(png), strictError: null, missingEoi: false, name: "a.png", path: null, minLongEdgePx: 2000, metrics: null }).some((i) => i.ruleId === "FILE_FORMAT"));
    const cand = (x: number, y: number) => ({ x, y, r: 6, bbox: [x - 6, y - 6, x + 6, y + 6] as [number, number, number, number], nx: x / 6000, ny: y / 4000, score: 10, depth: 12, area: 60, surfaceLuma: 200, surfaceStd: 1, surfaceL: 80, deltaL: -4 });
    const groups = CV.clusterDust([
      { id: "a", fullW: 6000, fullH: 4000, candidates: [cand(1200, 800), cand(4000, 3000)] },
      { id: "b", fullW: 6000, fullH: 4000, candidates: [cand(1240, 790)] },
      { id: "c", fullW: 6000, fullH: 4000, candidates: [cand(1190, 830)] },
      { id: "d", fullW: 4000, fullH: 6000, candidates: [cand(1200, 800)] },
    ]);
    c.ok("repeated dust: 3 photos within 1.5% of the long edge form one group (a portrait frame does not join)", groups.length === 1 && groups[0].photoCount === 3 && !groups[0].members.some((m) => m.photoId === "d"));
    c.ok("resolution outlier: a 2400 px photo in a 6000 px gallery", CV.resolutionOutliers([{ id: "a", dHash: null, contentHash: null, w: 6000, h: 4000 }, { id: "b", dHash: null, contentHash: null, w: 6000, h: 4000 }, { id: "c", dHash: null, contentHash: null, w: 2400, h: 1600 }]).map((o) => o.id).join() === "c");
    c.ok("an identical file is an exact duplicate", CV.duplicatePairs([{ id: "a", dHash: "00ff00ff00ff00ff", contentHash: "same", w: 1, h: 1 }, { id: "b", dHash: "ffffffffffffffff", contentHash: "same", w: 1, h: 1 }])[0]?.exact === true);
    // Timing: one 6000x4000 photo through every per-photo CV step.
    const big = await textured(6000, 4000, 21, false);
    const t0 = Date.now();
    const bm = await D.readMeta(big);
    await D.strictDecode(big);
    const braster = await D.decodeRaster(big, bm);
    for (const s of D.UI_SIZES) await D.renderFromRaster(braster, s);
    const bcv = await CV.analyzeRaster(braster, bm);
    await D.cutCrops(big, bm, bcv.dustCandidates.slice(0, 6).map((k) => ({ x: k.x, y: k.y })));
    const ms = Date.now() - t0;
    c.ok(`a 6000x4000 photo (${(big.length / 1048576).toFixed(1)} MB) through decode, 4 derivatives, CV and crops in ${ms} ms (well under 10 s)`, ms < 10_000);

    // ---- 8. the source dispatch ---------------------------------------------------------
    c.head("8 · where a photo's bytes come from (no network in this section)");
    c.ok("Aryeo's CDN, S3 and CloudFront hosts are allowed over https", S.checkSourceUrl("https://cdn.aryeo.com/listings/x/12 (1 of 30).jpg").ok && S.checkSourceUrl("https://bucket.s3.amazonaws.com/a.jpg").ok && S.checkSourceUrl("https://d111.cloudfront.net/a.jpg").ok);
    c.ok("http, other hosts, IP literals, localhost and credentials are refused", !S.checkSourceUrl("http://cdn.aryeo.com/a.jpg").ok && !S.checkSourceUrl("https://evil.example.com/a.jpg").ok && !S.checkSourceUrl("https://169.254.169.254/latest").ok && !S.checkSourceUrl("https://localhost/a.jpg").ok && !S.checkSourceUrl("https://u:p@cdn.aryeo.com/a.jpg").ok && !S.checkSourceUrl("https://cdn.aryeo.com.evil.io/a.jpg").ok);
    c.ok("a redirect may return to the host Aryeo named", S.checkSourceUrl("https://img.partner-cdn.net/a.jpg", "img.partner-cdn.net").ok);
    const tryLoad = async (row: Partial<Parameters<typeof S.loadPhotoBytes>[0]>) => { try { await S.loadPhotoBytes({ id: "x", name: "a.jpg", sourceKind: "DROPBOX", sourceUrl: null, sourceRef: null, dropboxPath: null, ...row }); return null; } catch (e) { return e as InstanceType<typeof S.PhotoSourceError>; } };
    const eAuto = await tryLoad({ sourceKind: "AUTOHDR", sourceRef: "uuid" });
    const eHost = await tryLoad({ sourceKind: "ARYEO", sourceUrl: "https://evil.example.com/a.jpg" });
    // Oct 14 2026: the hub's own AutoHDR photos are read now (display.ts); one the hub has not brought over is a clean refusal.
    c.ok("an AUTOHDR photo the hub has not brought over is a PhotoSourceError, never a crash", eAuto instanceof S.PhotoSourceError && (eAuto.kind === "refused" || eAuto.kind === "transient"));
    c.ok("a non-Aryeo host is refused before any request, with a reason for the FILE_OPENS finding", eHost instanceof S.PhotoSourceError && eHost.kind === "refused" && /not an Aryeo, S3 or CloudFront host/.test(eHost.publicReason));
    c.ok("…and nothing left the building", fence.blocked.length === 0, fence.blocked.join(", "));

    // ---- 9. the paid QC is off (Oct 23 2026) ------------------------------------------------
    // Jordan: "Paid Photo QC should be off. Only using the free version. I don't
    // need a paid QC, only paid fixes through AutoHDR." The engine that section
    // used to drive end to end was deleted on Oct 25 2026 (audit D7); this proves
    // the stored switches read off and nothing is left that could run it.
    c.head("9 · the paid QC is off: nothing starts, resumes or spends, whatever is stored");
    const { putSetting } = await import("@/lib/settings");
    const { photoDeliverySettings, PAID_QC_OFF } = await import("@/lib/photoDelivery/settings");
    await putSetting("photo_delivery:settings", { qcEnabled: true, paidQcAuto: true, qcShadow: true, maxBuildPhase: 1, minLongEdgePx: 2000, displayConfidenceFloor: 0.5, monthlyQcBudgetUsd: 300 }, "drill");
    const read = await photoDeliverySettings();
    c.ok("PAID_QC_OFF: a stored qcEnabled / paidQcAuto true reads off", PAID_QC_OFF === true && read.qcEnabled === false && read.paidQcAuto === false);
    const engine = ["run.ts", "claude.ts", "cost.ts", "normalize.ts", "index.ts", "prompts"].map((f) => path.join(REPO, "src/lib/photoDelivery/qc", f));
    c.ok("the paid engine is gone from the tree (Oct 25 2026, audit D7): nothing can start, resume or spend", engine.every((f) => !fs.existsSync(f)), engine.filter((f) => fs.existsSync(f)).join(", "));
    const cron = fs.readFileSync(path.join(REPO, "src/app/api/cron/photo-qc/route.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    c.ok("the photo-qc lane runs the free check and the fix planning, never driveQc or the coaching drafts", /driveAutohdrChecks/.test(cron) && /driveAutoFixPlanning/.test(cron) && !/driveQc|draftPendingCoaching/.test(cron));
    const jobsSrc = fs.readFileSync(path.join(REPO, "src/lib/photoDelivery/jobs.ts"), "utf8");
    c.ok("a changed gallery no longer raises the paid request flag", !/qcRequestedAt: now/.test(jobsSrc) && !/paidQcAuto/.test(jobsSrc));

    // ---- 10. the fence ----------------------------------------------------------------------
    c.head("10 · isolation");
    c.ok("provider fence stayed closed (no Anthropic, Aryeo, Dropbox, Blob, Slack or OpenPhone call)", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
