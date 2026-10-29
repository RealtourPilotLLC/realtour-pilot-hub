// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: THE CAMERA'S OWN FRAME, LEVEL LINES, CARS, CORDS AND KYLE'S REASONS
// (Oct 29 2026). Jordan, on Kyle's notes: "Build a comparison" (a cut-off
// roof against the camera's raw frame); "it's saying there is warping, but
// there isn't" (615 Cliff had real warps: walls, doors, door trim, windows);
// "Id like it to pick up horizontal lines that are not level"; cords only when
// they really stick out; "its been picking up cars in neighbors driveways";
// "Kyle should be typing reasons - please make sure you see his reasons".
//   1  the measurements (qc/cv.ts, pure, synthetic photos): lens bow, edit
//      against camera, level lines (a camera roll, not perspective), same
//      scene across exposures, the edit found in the camera frame, the roof
//   2  the camera frame from the raw folder (cameraFrame.ts): the middle
//      exposure of the bracket set AutoHDR named, never another shot; why not
//   3  what the comparison says, in the finding and on the card
//   4  the image route serves the kept frame (staff only, the finding's photo)
//   5  cars and cords: the free check's question and its code screen
//   6  Kyle's reasons: always asked (one tap), Skip all says why, his words
//      read right (a "Fixed in autohdr" is a fix, "Not the house" a neighbor's)
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT, default
// 7029). Dropbox and the private store are in-process fakes; every outbound
// call is fenced. Production is never opened.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch(async () => null);
const PORT = Number(process.env.DRILL_PORT ?? 7029);
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ---- synthetic photos (1024 x 683 gray) ---------------------------------------------------------
const W = 1024, H = 683;
type Luma = { l: Uint8Array; w: number; h: number };
const L = (l: Uint8Array): Luma => ({ l, w: W, h: H });
function draw(lines: ((y: number) => number)[], horiz: ((x: number) => number)[] = []): Uint8Array {
  const l = new Uint8Array(W * H).fill(200);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 200;
    for (const f of lines) { const d = Math.abs(x - f(y)); if (d < 3) v = 60; else if (d < 4) v = Math.min(v, 60 + (d - 3) * 140); }
    for (const f of horiz) { const d = Math.abs(y - f(x)); if (d < 3) v = 60; else if (d < 4) v = Math.min(v, 60 + (d - 3) * 140); }
    l[y * W + x] = v;
  }
  return l;
}
const XS = [80, 180, 280, 380, 480, 580, 680, 780, 880, 960];
const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
const noise = (x: number, y: number, s: number) => {
  let h = (Math.floor(x / s) * 374761393 + Math.floor(y / s) * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) % 48;
};
/** A house front: smooth sky, a gable roof with its peak at peakY (above the frame when negative), siding, windows, a lawn. */
function house(peakY: number): Uint8Array {
  const l = new Uint8Array(W * H);
  const eave = 0.38 * H, half = 0.36 * W;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const roofTop = peakY + (Math.abs(x - W / 2) / half) * (eave - peakY);
    let v = 205 + Math.round((y / H) * 20);
    if (y >= 0.9 * H) v = 80 + noise(x, y, 41);
    else if (Math.abs(x - W / 2) <= half && y >= roofTop && y < eave) v = 60 + noise(x, y, 37);
    else if (Math.abs(x - W / 2) <= 0.3 * W && y >= eave) {
      v = 130 + noise(x, y, 53);
      for (const wx of [0.3, 0.45, 0.6]) if (x > wx * W && x < (wx + 0.08) * W && y > 0.5 * H && y < 0.72 * H) v = 50;
      if (x > 0.48 * W && x < 0.53 * W && y > 0.6 * H) v = 40;
    }
    l[y * W + x] = Math.max(0, Math.min(255, v));
  }
  return l;
}
const IMG = {
  straight: draw(XS.map((x0) => () => x0), [() => 100, () => 600]),
  // Walls bowing out from the middle of the photo (the edit's lens correction off).
  bowed: draw(XS.map((x0) => (y: number) => x0 + 0.00012 * (y - H / 2) ** 2 * (x0 < W / 2 ? -1 : 1)), [(x) => 100 + 0.00008 * (x - W / 2) ** 2]),
  // The camera rolled: plumb walls, the ceiling line and the baseboard slope 1.2° the same way.
  offLevel: draw([() => 150, () => 870], [(x) => 90 + (x - W / 2) * tan(1.2), (x) => 610 + (x - W / 2) * tan(1.2)]),
  level: draw([() => 150, () => 870], [() => 90, () => 610]),
  // A wall shot at an angle: the ceiling line and the baseboard meet off the right edge (perspective, not a roll).
  perspective: draw([() => 150, () => 870], [(x) => 90 + (x - W / 2) * tan(1.2), (x) => 610 - (x - W / 2) * tan(1.2)]),
  // Another shot entirely (the next bracket set).
  other: draw([() => 300, () => 333, () => 700], [() => 250, () => 420]),
};
const raw = (l: Uint8Array) => sharp(Buffer.from(l), { raw: { width: W, height: H, channels: 1 } });
const jpeg = (l: Uint8Array) => raw(l).jpeg({ quality: 95 }).toBuffer();
const exposed = (l: Uint8Array, gain: number) => l.map((v) => Math.min(255, Math.round(v * gain)));
/** The edit as a crop of the camera frame (AutoHDR straightening, then cropping). */
async function crop(l: Uint8Array, left: number, top: number, width: number): Promise<Uint8Array> {
  const height = Math.round((width * H) / W);
  const { data } = await raw(l).extract({ left, top, width, height }).resize(W, H).greyscale().raw().toBuffer({ resolveWithObject: true });
  return new Uint8Array(data.buffer, data.byteOffset, W * H);
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-camera-frame" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const cv = await import("@/lib/photoDelivery/qc/cv");
    const cf = await import("@/lib/photoDelivery/cameraFrame");
    const geometry = await import("@/lib/photoDelivery/geometry");
    const check = await import("@/lib/photoDelivery/autohdrCheck");
    const house_ = await import("@/lib/photoDelivery/houseRules");
    const policy = await import("@/lib/photoDelivery/fixPolicy");
    const decisions = await import("@/lib/photoDelivery/decisions");
    const B = await import("@/lib/photoDelivery/blob");
    const { CameraCompare, cameraLine } = await import("@/components/photoDelivery/CameraCompare");

    // ======================================================================
    c.head("1 · the measurements (pure)");
    const bow = (l: Uint8Array) => cv.lensBow(l, W, H);
    const straight = bow(IMG.straight), bowed = bow(IMG.bowed);
    c.ok("straight walls: no bow", straight.k === 0 && straight.gain === 0 && straight.lines >= 6, JSON.stringify({ k: straight.k, gain: straight.gain, lines: straight.lines }));
    c.ok("bowed walls: the bow found, and it straightens them", bowed.k >= cv.LENS_THRESHOLDS.editMinK && bowed.gain >= cv.LENS_THRESHOLDS.strongGain, JSON.stringify({ k: bowed.k, gain: bowed.gain }));
    const bent = cv.editBowVerdict(bowed, straight), same = cv.editBowVerdict(bowed, bowed);
    c.ok("the edit bows where the camera is straight: bent by the edit, strongly", bent.bowed && bent.strong && bent.gap >= cv.LENS_THRESHOLDS.strongGap, JSON.stringify(bent));
    c.ok("the camera bows the same: not the edit (the lens, or the normal wide look)", !same.bowed && !same.strong && same.gap === 0, JSON.stringify(same));
    c.ok("a straight edit is never bowed, whatever the camera", !cv.editBowVerdict(straight, bowed).bowed);
    const lv = (l: Uint8Array) => cv.notLevel(bow(l).level);
    const off = lv(IMG.offLevel);
    c.ok("the camera rolled: the ceiling line and the baseboard slope the same way, 1.2°", !!off && Math.abs(off.deg - 1.2) < 0.15 && off.lines >= cv.LENS_THRESHOLDS.levelMinLines, JSON.stringify(off));
    c.ok("level lines: nothing", lv(IMG.level) === null);
    c.ok("a wall shot at an angle (lines meeting in the distance): perspective, not off level", lv(IMG.perspective) === null, JSON.stringify(bow(IMG.perspective).level));
    c.ok("never a slope steeper than 2.5° (a staircase, a roof line)", cv.notLevel([{ deg: 4, y: 0.1, len: 0.8 }, { deg: 4, y: 0.9, len: 0.8 }]) === null);
    c.ok("never lines near the middle of the photo (the horizon of the room bends least)", cv.notLevel([{ deg: 1, y: 0.45, len: 0.8 }, { deg: 1, y: 0.55, len: 0.8 }]) === null);
    c.ok("the same scene across exposures; another shot is not", cv.sameScene(L(IMG.straight), L(exposed(IMG.straight, 0.35))) >= cv.LENS_THRESHOLDS.sameScene && cv.sameScene(L(IMG.straight), L(IMG.other)) < cv.LENS_THRESHOLDS.sameScene);
    const lines = new Uint8Array(W * H).fill(200);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ([70, 130, 260, 300, 410, 560, 590, 720, 850, 930].some((a) => Math.abs(x - a) < 3) || [60, 150, 170, 330, 480, 520, 640].some((b) => Math.abs(y - b) < 3)) lines[y * W + x] = 60;
    const fitIdentity = cv.alignFrame(L(lines), L(lines));
    const fitCrop = cv.alignFrame(L(await crop(lines, 90, 110, 840)), L(lines));
    c.ok("the edit found in the camera frame: the same framing", fitIdentity.score > 0.95 && fitIdentity.scale === 1 && fitIdentity.top === 0, JSON.stringify(fitIdentity));
    c.ok("…and a crop of it (82%, 9% in, 16% down)", fitCrop.score >= cv.LENS_THRESHOLDS.alignMin && Math.abs(fitCrop.scale - 0.82) <= 0.02 && Math.abs(fitCrop.left - 0.088) <= 0.02 && Math.abs(fitCrop.top - 0.161) <= 0.02, JSON.stringify(fitCrop));
    const roofOf = async (peak: number, top: number) => {
      const cam = house(peak);
      const edit = await crop(cam, 90, top, 840);
      return cv.roofHeadroom(L(edit), L(cam), cv.alignFrame(L(edit), L(cam)));
    };
    const roofEdit = await roofOf(0.1 * H, 110), roofShoot = await roofOf(-0.08 * H, 30), roofWhole = await roofOf(0.15 * H, 20);
    c.ok("the roof: sky above the peak in the camera frame, cut in the edit → the edit cut it", roofEdit.verdict === "edit" && roofEdit.cameraCut === 0 && roofEdit.cameraSky > 0, JSON.stringify(roofEdit));
    c.ok("the roof: cut off in the camera frame too → framed that way at the shoot (Kyle: \"already cropped in the originals\")", roofShoot.verdict === "capture" && roofShoot.cameraCut > 0, JSON.stringify(roofShoot));
    c.ok("the roof whole in the edit: nothing to say", roofWhole.verdict === "unclear" && roofWhole.cutShare < 0.03, JSON.stringify(roofWhole));

    // ======================================================================
    c.head("2 · the camera frame from the raw folder");
    c.ok("the bracket order searched: the named frame, then the neighbours a set can hold its middle exposure in", JSON.stringify(cf.candidateIndexes(3, 10)) === "[3,4,0,2,1,5]" && JSON.stringify(cf.candidateIndexes(0, 3)) === "[0,1,2]");
    const frames = new Map<string, Buffer>();
    const readsOf: string[] = [];
    cf.__setCameraFrameReadForTests(async (p) => {
      readsOf.push(p);
      const b = frames.get(p);
      if (!b) throw new Error("not found in the drill's Dropbox");
      return b;
    });
    const kept = new Map<string, Buffer>();
    B.__setDerivativeStoreForTests({
      async put(pathname, bytes) { kept.set(pathname, Buffer.from(bytes)); return { pathname, url: `https://drill-store.private.blob.vercel-storage.invalid/${pathname}` }; },
      async read(ref) { const b = kept.get(ref.pathname); return b ? { stream: new Blob([new Uint8Array(b)]).stream(), size: b.length, contentType: "image/jpeg" } : null; },
    });
    const client = await prisma.client.create({ data: { name: "Camera Frame Client" } });
    const project = await prisma.project.create({ data: { title: "615 Cliff Rd, Reading, PA", addressLine: "615 Cliff Rd", clientId: client.id } });
    const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "QC_REVIEW" } });
    // A Sony 5-shot set (0, -, +, --, ++: AutoHDR names the 4th, the darkest), then an A7 V 3-shot set (-, 0, +: it names the 1st) with the next shot after it.
    const files: { name: string; path: string; size: number }[] = [];
    const put = async (name: string, img: Uint8Array, gain: number) => {
      const p = `/615 Cliff Rd/01-RAW-Photos/${name}`;
      files.push({ name, path: p, size: 25_000_000 });
      frames.set(p, await jpeg(exposed(img, gain)));
    };
    for (const [i, g] of [0.6, 0.4, 0.85, 0.25, 1.1].entries()) await put(`DSC0010${i}.ARW`, IMG.straight, g);
    // The 3-shot set: dark, then two too bright; the shot before it (same folder) is exposed just right but is another scene.
    await put("DSC00200.ARW", IMG.other, 0.6);
    for (const [i, g] of [0.3, 1.25, 0.8].entries()) await put(`DSC0030${i}.ARW`, IMG.bowed, g);
    await prisma.photoIntakeBatch.create({
      data: {
        projectId: project.id, batchNo: 1, state: "DONE", rawPath: "/615 Cliff Rd/01-RAW-Photos", filesJson: JSON.stringify([...files].reverse()), fileCount: files.length, fingerprint: "fp615", expectedPhotos: 3, imageCount: 3, photoshootId: 615,
        photosJson: JSON.stringify([{ image_uuid: "img-sony", name: "DSC00103.ARW" }, { image_uuid: "img-a75", name: "dsc00300.arw" }, { image_uuid: "img-gone", name: "DSC00999.ARW" }]),
        seenAt: new Date(), doneAt: new Date(),
      },
    });
    const sony = await cf.cameraFrameOf({ autohdrImageUuid: "img-sony" }, project.id);
    c.ok("Sony 5-shot: the named dark frame read first, the middle exposure (the 1st of the set) chosen", "frame" in sony && sony.frame.name === "DSC00100.ARW" && readsOf[0].endsWith("DSC00103.ARW") && Math.abs(sony.frame.mean - 115) <= 30 && sony.frame.luma.w === 1024, "frame" in sony ? `${sony.frame.name} mean ${sony.frame.mean}, read ${readsOf.map((r) => path.basename(r)).join(",")}` : sony.skipped);
    readsOf.length = 0;
    const a75 = await cf.cameraFrameOf({ autohdrImageUuid: "img-a75" }, project.id);
    c.ok("A7 V 3-shot (names matched whatever their case): the shot before is better exposed but another scene, never taken; the best of its own set is", "frame" in a75 && a75.frame.name === "DSC00302.ARW" && readsOf.some((r) => r.endsWith("DSC00200.ARW")), "frame" in a75 ? `${a75.frame.name} mean ${a75.frame.mean}` : a75.skipped);
    const why = async (p: { autohdrImageUuid: string | null }) => { const r = await cf.cameraFrameOf(p, project.id); return "skipped" in r ? r.skipped : "found"; };
    c.ok("why not, in words: not linked to AutoHDR; not in the intake; its file missing from the list", /not linked to its AutoHDR upload/.test(await why({ autohdrImageUuid: null })) && /not in the hub's intake records/.test(await why({ autohdrImageUuid: "img-elsewhere" })) && /DSC00999\.ARW is not in the intake list/.test(await why({ autohdrImageUuid: "img-gone" })));
    frames.delete("/615 Cliff Rd/01-RAW-Photos/DSC00103.ARW");
    c.ok("the named frame unreadable: said so (nothing guessed from its neighbours)", /DSC00103\.ARW could not be read/.test(await why({ autohdrImageUuid: "img-sony" })));
    frames.set("/615 Cliff Rd/01-RAW-Photos/DSC00103.ARW", await jpeg(exposed(IMG.straight, 0.25)));
    const keptRef = "frame" in sony ? await cf.keepCameraFrame(job.id, "photo1", sony.frame) : null;
    c.ok("the frame kept in the private store, one per photo and frame", keptRef?.pathname === `camera-frames/${job.id}/photo1/dsc00100.jpg` && kept.has(keptRef.pathname), keptRef?.pathname ?? "none");

    // ======================================================================
    c.head("3 · what the comparison says");
    const ROOF = "PERSP_AUTOHDR_ROOF_PEAKS_CROPPED", WARP = "PERSP_EDIT_WARP";
    const v = geometry.cameraVerdict;
    const capture = v(ROOF, { frame: "DSC00100.ARW", roof: "capture" })!;
    c.ok("roof cut at the shoot: the photographer's, coaching, no edit asked for", capture.verdict === "capture" && capture.responsibility === "PHOTOGRAPHER" && /No edit brings the roof back/.test(capture.action ?? "") && /\(DSC00100\.ARW\)/.test(capture.note));
    const editRoof = v(ROOF, { roof: "edit" })!;
    c.ok("roof cut by the edit: the editor's, Perspective Off in AutoHDR (free)", editRoof.responsibility === "EDITOR" && editRoof.action === policy.AUTOHDR_FREE_FIX[ROOF]);
    c.ok("warp bent by the edit: the editor's, and tell AutoHDR its lens correction is off", v(WARP, { bowed: true })?.responsibility === "EDITOR" && /lens correction/.test(v(WARP, { bowed: true })?.action ?? ""));
    c.ok("warp the same in the camera: not the edit, nobody blamed", v(WARP, { bowed: false })?.verdict === "same" && !v(WARP, { bowed: false })?.responsibility);
    c.ok("not compared: why, and that the frame is beside it when kept", /Not compared with the camera's own frame \(DSC1\.ARW\): the edit x\. It is shown beside the edit/.test(v(ROOF, { frame: "DSC1.ARW", skipped: "the edit x", preview: { pathname: "p", url: "u" } })?.note ?? "") && v(WARP, undefined) === null);
    c.ok("the card's line, both checks", /framed that way at the shoot/.test(cameraLine(ROOF, "capture")) && /the edit cut it off/.test(cameraLine(ROOF, "edit")) && /the edit bent the lines/.test(cameraLine(WARP, "edit")) && /not the edit/.test(cameraLine(WARP, "same")));
    const card = (camera: { frame: string; verdict: string } | null) =>
      renderToStaticMarkup(createElement(CameraCompare, { f: { id: "f1", photoId: "p1", ruleId: ROOF, camera } as never, photo: { id: "p1", contentHash: "h1", sourceUrl: null } as never }) as ReactElement);
    const shownCard = card({ frame: "DSC00100.ARW", verdict: "capture" });
    c.ok("the card: the edit beside the camera's own frame, named, each opening full size, with what it found", /Camera&#x27;s own frame · DSC00100\.ARW/.test(shownCard) && /camera=f1/.test(shownCard) && /target="_blank"/.test(shownCard) && /framed that way at the shoot/.test(shownCard) && card(null) === "", shownCard.slice(0, 300));
    c.ok("the card shows on a finding only when a frame was kept (data.ts), in the issues list and the lightbox", /return cam\?\.preview\?\.pathname \?/.test(read("src/app/ops/photo-delivery/data.ts")) && /<CameraCompare/.test(read("src/components/photoDelivery/IssuesPanel.tsx")) && /<CameraCompare/.test(read("src/components/photoDelivery/Lightbox.tsx")));
    c.ok("interiors only for level and warp found by measurement alone", geometry.isInterior({ roomType: "BATHROOM" }) && !geometry.isInterior({ roomType: "EXTERIOR_FRONT" }) && !geometry.isInterior({ roomType: "DECK" }) && !geometry.isInterior({ roomType: "LIVING", isAerial: true }) && !geometry.isInterior({ roomType: null }));

    // ======================================================================
    c.head("4 · the image route serves the kept frame");
    const { setSession } = await import("@/lib/auth/session");
    const { NextRequest } = await import("next/server");
    const imgRoute = await import("@/app/api/photo-delivery/img/[photoId]/[size]/route");
    const photo = await prisma.photoAsset.create({ data: { jobId: job.id, name: "615-13.jpg", sourceKind: "AUTOHDR", sourceRef: "615/img-sony", autohdrImageUuid: "img-sony", contentHash: "h615", sequence: 0, status: "ACTIVE", roomType: "BATHROOM" } });
    const other = await prisma.photoAsset.create({ data: { jobId: job.id, name: "615-14.jpg", sourceKind: "AUTOHDR", sourceRef: "615/img-a75", autohdrImageUuid: "img-a75", contentHash: "h616", sequence: 1, status: "ACTIVE" } });
    const run = await prisma.photoQcRun.create({ data: { jobId: job.id, rulesVersion: "drill", trigger: "AUTOHDR_CHECK" } });
    const mkFinding = (data: Record<string, unknown>) => prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: job.id, photoId: photo.id, ruleId: WARP, groupKey: "ARCHITECTURE_WARP", pass: "P1_PHOTO", source: "AHDR", specificIssue: "Bowed shower wall", explanation: "x", severity: "MINOR", confidence: 0.7, responsibility: "EDITOR", fixStrategy: "HUMAN_REVIEW", ...data } as never });
    const withFrame = await mkFinding({ coercedJson: JSON.stringify({ camera: { frame: "DSC00100.ARW", preview: keptRef, verdict: "edit" } }) });
    const noFrame = await mkFinding({ coercedJson: JSON.stringify({ camera: { skipped: "x", verdict: "unclear" } }) });
    const get = (photoId: string, q: string) => imgRoute.GET(new NextRequest(`http://drill.local/api/photo-delivery/img/${photoId}/qc1024?${q}`), { params: Promise.resolve({ photoId, size: "qc1024" }) });
    const kyle = await prisma.appUser.create({ data: { email: "kyle@camera.test", name: "Kyle", role: "ADMIN", status: "ACTIVE" } });
    await setSession({ uid: kyle.id, email: kyle.email, role: "ADMIN" });
    const shown = await get(photo.id, `camera=${withFrame.id}`);
    const body = Buffer.from(await shown.arrayBuffer());
    c.ok("the camera frame served for its finding (private, cached by frame)", shown.status === 200 && body.equals(kept.get(keptRef!.pathname)!) && /^"?cam-/.test(shown.headers.get("etag") ?? "") && /private/.test(shown.headers.get("cache-control") ?? ""), `${shown.status} ${shown.headers.get("etag")} ${shown.headers.get("cache-control")}`);
    c.ok("no frame kept: 404, nothing else served in its place", (await get(photo.id, `camera=${noFrame.id}`)).status === 404);
    c.ok("a finding of another photo: 404", (await get(other.id, `camera=${withFrame.id}`)).status === 404);
    const viewer = await prisma.appUser.create({ data: { email: "editor@camera.test", name: "An editor", role: "EDITOR", status: "ACTIVE" } });
    await setSession({ uid: viewer.id, email: viewer.email, role: "EDITOR" });
    const asEditor = await get(photo.id, `camera=${withFrame.id}`);
    c.ok("an editor (not on the photo desk): 403", asEditor.status === 403, String(asEditor.status));
    await setSession({ uid: kyle.id, email: kyle.email, role: "ADMIN" });

    // ======================================================================
    c.head("5 · cars and cords");
    const q = check.checkPrompt(new Set());
    c.ok("cars: only this home's driveway or carport, a car in the near foreground only when it distracts and only street or lawn is behind it", /EXT_PARKED_CARS_DRIVEWAY: a car parked in the driveway or carport of the home being photographed \(never a car in any other driveway/.test(q) && /EXT_VEHICLES_BLOCKING_HOME: a car in the near foreground/.test(q) && /only street, sidewalk or lawn behind it/.test(q));
    c.ok("cords: only when they really stick out (across open floor, a bunch hanging from a TV, nightstand or counter), never one to an outlet or wiring that is part of the house", /cords that really stick out/.test(q) && /a bunch of loose cords hanging from a TV, nightstand or countertop/.test(q) && /never a single cord to an outlet/.test(q) && /wiring that is part of the house/.test(q));
    c.ok("warps named the way Jordan looks for them; level lines asked", /walls, wall corners, doors, door trim or window frames that bow/.test(q) && /small rooms/.test(q) && /PERSP_HORIZONTAL_DISTORTION:/.test(q) && check.CHECK_PROMPT_VERSION >= 7);
    const screen = (ruleId: string, where: string) => check.screenIssues({ room: "front exterior", issues: [{ ruleId, where, confidence: 0.9 }] }, { alwaysFlag: policy.ALWAYS_FLAG });
    const dropped = (ruleId: string, where: string) => screen(ruleId, where).dropped[0]?.why ?? null;
    c.ok("a car in a neighbor's driveway, on the street, in the background: dropped", ["SUV in the neighbor's driveway on the right", "car parked on the street, far left", "a car in the background across the road", "cars in the driveways up the street"].every((w) => dropped("EXT_PARKED_CARS_DRIVEWAY", w)));
    c.ok("a car in this home's own driveway: kept (always fixed)", !dropped("EXT_PARKED_CARS_DRIVEWAY", "silver sedan in the driveway in front of the garage") && !dropped("EXT_PARKED_CARS_DRIVEWAY", "car under the carport"));
    c.ok("a street car in the near foreground: kept (the one Jordan removes); one far off: dropped", !dropped("EXT_VEHICLES_BLOCKING_HOME", "pickup on the street in the foreground, bottom left") && !!dropped("EXT_VEHICLES_BLOCKING_HOME", "a van parked across the street in the background"));
    const cord = (where: string) => dropped("PREP_LOOSE_CORDS_CABLES", where);
    c.ok("cords that are part of the house or barely stick out: dropped", ["power cord behind the TV stand", "cable running to the wall outlet", "lamp cord behind the nightstand", "wires on the porch light by the siding"].every((w) => cord(w) === "a cord that belongs to the house"));
    c.ok("cords that really stick out: kept, even by a TV or a nightstand", ["extension cord running across the open floor", "a bunch of cords hanging from the TV", "several loose cords hanging off the nightstand", "tangled cables on the kitchen countertop"].every((w) => cord(w) === null));

    // ======================================================================
    c.head("6 · Kyle's reasons");
    const jc = read("src/components/photoDelivery/JobContext.tsx");
    const ignoreAsk = jc.slice(jc.indexOf('} else if (status === "IGNORED") {'), jc.indexOf('} else if (status === "FALSE_POSITIVE") {'));
    const notThereAsk = jc.slice(jc.indexOf('} else if (status === "FALSE_POSITIVE") {'), jc.indexOf('} else if (status === "OVERRIDDEN") {'));
    c.ok("Not worth fixing always asks why, a preset one tap (minor issues too)", /required: true/.test(ignoreAsk) && /presets: IGNORE_PRESETS/.test(ignoreAsk) && !/optional/.test(ignoreAsk));
    c.ok("Not there always asks too, and points a fix done by hand to Fixed in AutoHDR", /required: true/.test(notThereAsk) && /Press Fixed in AutoHDR instead/.test(notThereAsk) && !/FALSE_POSITIVE" && required/.test(jc));
    const ip = read("src/components/photoDelivery/IssuesPanel.tsx");
    c.ok("Skip all asks why (presets, required) and sends it", /presets: SKIP_ALL_PRESETS/.test(ip) && /skipAllFindingsAction\(jobId, why\)/.test(ip) && /export async function skipAllFindingsAction\(jobId: string, reason\?: string \| null\)/.test(read("src/app/ops/photo-delivery/actions.ts")));
    const open1 = await mkFinding({ ruleId: "PREP_CLEANING_SUPPLIES", groupKey: "PREP", specificIssue: "Broom by the door" });
    const open2 = await mkFinding({ ruleId: "EXT_GARDEN_HOSES", groupKey: "EXT", specificIssue: "Hose on the lawn", photoId: other.id });
    await prisma.photoQcFinding.updateMany({ where: { id: { in: [withFrame.id, noFrame.id] } }, data: { status: "SUPERSEDED" } });
    const skip = await decisions.skipAllFindings(job.id, "Kyle", "  Checked every photo:   nothing worth fixing ");
    const after = await prisma.photoQcFinding.findMany({ where: { id: { in: [open1.id, open2.id] } } });
    const ev = await prisma.photoJobEvent.findFirst({ where: { jobId: job.id, action: { startsWith: "Skipped all findings" } }, orderBy: { at: "desc" } });
    c.ok("Skip all keeps his words with every issue it sets aside", skip.ok && after.every((f) => f.status === "IGNORED" && f.statusReason === "Skipped all findings on this shoot: Checked every photo: nothing worth fixing" && f.decidedBy === "Kyle"), after.map((f) => f.statusReason).join(" | "));
    c.ok("…and in the job's activity", /Why: Checked every photo: nothing worth fixing/.test(ev?.action ?? ""), ev?.action ?? "none");
    c.ok("…and a Skip all still never teaches the check", house_.lessonOf(after[0].statusReason) === null);
    const lesson = (r: string) => house_.lessonOf(r)?.scope ?? "nothing";
    c.ok("his calls about one photo teach nothing (the camera frame now answers them)", ["Checked raws, they're the same", "Theyre already cropped in the originals", "That's how it's taken", "That’s how it’s taken", "Fixed in autohdr", "fixed with autohdr", "Has other zoomed out photos", "Re-editing this myself, to fix the sink foset"].every((r) => lesson(r) === "nothing"));
    c.ok("\"Not the house\" and \"Neighbors car\": a neighbor's; \"Barely visible\", \"Part of the house\", \"Intentional staging\" as before", lesson("Not the house") === "neighbor" && lesson("Neighbors car") === "neighbor" && lesson("Barely visible") === "faint" && lesson("Part of the house") === "attached" && lesson("Intentional staging") === "staged");
    // Five "Not there: Fixed in autohdr" and one plain "Not there" on driveway cars: the car was there and fixed, so the check is not made stricter.
    const mkCall = (status: string, statusReason: string) => mkFinding({ ruleId: "EXT_PARKED_CARS_DRIVEWAY", groupKey: "EXT", status, statusReason, decidedBy: "Kyle Smith", decidedAt: new Date() });
    for (let i = 0; i < 5; i++) await mkCall("FALSE_POSITIVE", i % 2 ? "Fixed in autohdr" : "fixed with AutoHDR");
    await mkCall("FALSE_POSITIVE", "Nothing like this is in the photo");
    const learnt = (await policy.learnedRules()).get("EXT_PARKED_CARS_DRIVEWAY");
    c.ok("\"Not there: Fixed in autohdr\" counts as a car that was there and wanted fixed, never makes the check stricter", learnt?.wanted === 5 && learnt.notThere === 1 && !learnt.strict, JSON.stringify(learnt));

    c.head("isolation");
    c.ok("nothing left the hub", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();
