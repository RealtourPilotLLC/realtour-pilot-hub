// ---------------------------------------------------------------------------
// DRILL: A CAMERA TURNED LEFT OR RIGHT, NOT JUST ROTATED (Oct 29 2026).
// Jordan: "for horizontal lines, it also should look for when the camera is
// turned left and right, not just rotated. Thats really what I mean. When a
// single-point perspective is shot, the back wall line where the wall and
// ceiling meet should be straight, and I want it to detect that."
//   1  the measurement (qc/cv.ts levelVerdict, pure) on rooms drawn through a
//      real camera: faced square on, turned left, turned right, a little,
//      the floor line hidden, rolled (the existing finding), a corner shot
//      and a shallow corner (never flagged); and the shapes calibration on
//      631 room photos taught it to leave alone
//   2  the words: which way, in plain words; a fix that is not Crop & Tilt
//      (turning levels one line and tips the other); who does it
//   3  end to end (geometry.ts): measured alone → MINOR but shown, with the
//      free check too → MAJOR, a rotation keeps Crop & Tilt, a corner and an
//      outside photo say nothing, nothing filed twice
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT, default
// 7031). Photo bytes come from an in-process loader; every outbound call is
// fenced. Production is never opened.
// ---------------------------------------------------------------------------
import sharp from "sharp";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch(async () => null);
const PORT = Number(process.env.DRILL_PORT ?? 7031);

// ---- rooms drawn through a camera (1024 x 683 gray, dark lines on a light wall) ------------------
const W = 1024, H = 683, F = 512; // about a 90° wide lens
type P3 = [number, number, number];
/** World (X right, Y up, Z ahead, metres) to the photo. yaw > 0 turns the camera LEFT; roll > 0 turns the picture clockwise. */
function project([X, Y, Z]: P3, yaw: number, roll: number): [number, number] | null {
  const t = (yaw * Math.PI) / 180, r = (roll * Math.PI) / 180;
  const xc = X * Math.cos(t) + Z * Math.sin(t), zc = -X * Math.sin(t) + Z * Math.cos(t);
  if (zc < 0.2) return null;
  const u = (F * xc) / zc, v = (-F * Y) / zc;
  return [W / 2 + u * Math.cos(r) - v * Math.sin(r), H / 2 + u * Math.sin(r) + v * Math.cos(r)];
}
function render(segs: [P3, P3][], yaw = 0, roll = 0): Uint8Array {
  const l = new Uint8Array(W * H).fill(200);
  for (const [a, b] of segs) {
    const p = project(a, yaw, roll), q = project(b, yaw, roll);
    if (!p || !q) continue;
    const dx = q[0] - p[0], dy = q[1] - p[1], L2 = dx * dx + dy * dy;
    const x0 = Math.max(0, Math.floor(Math.min(p[0], q[0]) - 4)), x1 = Math.min(W - 1, Math.ceil(Math.max(p[0], q[0]) + 4));
    const y0 = Math.max(0, Math.floor(Math.min(p[1], q[1]) - 4)), y1 = Math.min(H - 1, Math.ceil(Math.max(p[1], q[1]) + 4));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const s = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / L2));
      const d = Math.hypot(x - p[0] - s * dx, y - p[1] - s * dy);
      const i = y * W + x;
      if (d < 3) l[i] = 60;
      else if (d < 4) l[i] = Math.min(l[i], 60 + (d - 3) * 140);
    }
  }
  return l;
}
// A room 5 m wide, its back wall 4 m away, eye level 1.5 m up a 2.7 m wall: the back wall's top and bottom, its corners,
// a door and a window on it, and the side walls' top and bottom edges running back to the camera.
const D = 4, XW = 2.5, YC = 1.2, YF = -1.5;
const ROOM: [P3, P3][] = [
  [[-XW, YC, D], [XW, YC, D]], [[-XW, YF, D], [XW, YF, D]],
  [[-XW, YF, D], [-XW, YC, D]], [[XW, YF, D], [XW, YC, D]],
  [[0.6, YF, D], [0.6, 0.6, D]], [[1.4, YF, D], [1.4, 0.6, D]], [[0.6, 0.6, D], [1.4, 0.6, D]],
  [[-1.8, -0.5, D], [-1.8, 0.7, D]], [[-0.6, -0.5, D], [-0.6, 0.7, D]], [[-1.8, 0.7, D], [-0.6, 0.7, D]], [[-1.8, -0.5, D], [-0.6, -0.5, D]],
  [[-XW, YC, D], [-XW, YC, 0.3]], [[XW, YC, D], [XW, YC, 0.3]], [[-XW, YF, D], [-XW, YF, 0.3]], [[XW, YF, D], [XW, YF, 0.3]],
];
/** The floor line hidden (a sofa along the back wall): only the ceiling line, Jordan's line. */
const CEILING_ONLY = ROOM.filter((_, i) => i !== 1 && i !== 13 && i !== 14);
/** A corner faced: two walls meeting straight ahead, running back toward the camera `a` degrees off square (two-point). */
function corner(a: number): [P3, P3][] {
  const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180), L = 3.5;
  return [
    [[0, YC, D], [-L * c, YC, D - L * s]], [[0, YC, D], [L * c, YC, D - L * s]],
    [[0, YF, D], [-L * c, YF, D - L * s]], [[0, YF, D], [L * c, YF, D - L * s]],
    [[0, YF, D], [0, YC, D]], [[-2 * c, YF, D - 2 * s], [-2 * c, YC, D - 2 * s]], [[2 * c, YF, D - 2 * s], [2 * c, YC, D - 2 * s]],
    [[-c, YF, D - s], [-c, 0.6, D - s]],
  ];
}
const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
/** The camera-frame drill's simple drawings: plumb walls and two lines across. */
function draw(xs: number[], horiz: ((x: number) => number)[]): Uint8Array {
  const l = new Uint8Array(W * H).fill(200);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 200;
    for (const x0 of xs) { const d = Math.abs(x - x0); if (d < 3) v = 60; else if (d < 4) v = Math.min(v, 60 + (d - 3) * 140); }
    for (const f of horiz) { const d = Math.abs(y - f(x)); if (d < 3) v = 60; else if (d < 4) v = Math.min(v, 60 + (d - 3) * 140); }
    l[y * W + x] = v;
  }
  return l;
}
const IMG = {
  square: render(ROOM),
  left: render(ROOM, 3),
  right: render(ROOM, -3),
  littleLeft: render(ROOM, 1.5),
  ceilingOnly: render(CEILING_ONLY, 3),
  rolled: render(ROOM, 0, 1.2),
  rolledBack: render(ROOM, 0, -1.2),
  corner: render(corner(45)),
  shallowCorner: render(corner(8)),
  shallowCornerTurned: render(corner(8), 3),
  // The camera-frame drill's "wall shot at an angle": the ceiling line and the baseboard meet off the right edge.
  meetRight: draw([150, 870], [(x) => 90 + (x - W / 2) * tan(1.2), (x) => 610 - (x - W / 2) * tan(1.2)]),
  // ...and its rolled camera: both lines slope 1.2° the same way.
  sameWay: draw([150, 870], [(x) => 90 + (x - W / 2) * tan(1.2), (x) => 610 + (x - W / 2) * tan(1.2)]),
};
const jpeg = (l: Uint8Array) => sharp(Buffer.from(l), { raw: { width: W, height: H, channels: 1 } }).jpeg({ quality: 95 }).toBuffer();
const DASH = /[–—]/;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-photo-yaw" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const cv = await import("@/lib/photoDelivery/qc/cv");
    const geometry = await import("@/lib/photoDelivery/geometry");
    const policy = await import("@/lib/photoDelivery/fixPolicy");
    const { savePhotoDeliverySettings, photoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const S = await import("@/lib/photoDelivery/qc/source");

    // ======================================================================
    c.head("1 · the measurement (pure), rooms drawn through a camera");
    const bow = (l: Uint8Array) => cv.lensBow(l, W, H);
    const verdict = (l: Uint8Array) => cv.levelVerdict(bow(l));
    const say = (l: Uint8Array) => { const b = bow(l); return JSON.stringify({ roll: b.roll, verdict: cv.levelVerdict(b), across: b.across.map((a) => [a.deg, a.y]) }); };
    c.ok("a room faced square on: nothing", verdict(IMG.square) === null, say(IMG.square));
    const left = bow(IMG.left), vLeft = cv.levelVerdict(left);
    const top = left.across.filter((a) => a.y < 0.4), bottom = left.across.filter((a) => a.y > 0.6);
    c.ok("turned 3° to the LEFT: the back wall's ceiling line runs downhill to the left (rises to the right), its floor line downhill to the right", top.length > 0 && top.every((a) => a.deg < -0.5) && bottom.length > 0 && bottom.every((a) => a.deg > 0.5), JSON.stringify(left.across));
    c.ok("…read as turned left, both lines agreeing, the walls still plumb", vLeft?.kind === "turned" && vLeft.side === "left" && vLeft.both && left.roll === 0, JSON.stringify({ roll: left.roll, vLeft }));
    c.ok("…and the old rotation measure says nothing (the lines slope opposite ways)", cv.notLevel(left.level) === null);
    const vRight = verdict(IMG.right);
    c.ok("turned 3° to the RIGHT: turned right", vRight?.kind === "turned" && vRight.side === "right" && vRight.both, say(IMG.right));
    const vLittle = verdict(IMG.littleLeft);
    c.ok("turned only 1.5° (the lines slope about half a degree): still caught", vLittle?.kind === "turned" && vLittle.side === "left" && vLittle.deg >= 0.4 && vLittle.deg < 0.8, say(IMG.littleLeft));
    const vCeil = verdict(IMG.ceilingOnly);
    c.ok("the floor line hidden, only the line where the wall meets the ceiling: turned left (the walls measured plumb)", vCeil?.kind === "turned" && vCeil.side === "left" && !vCeil.both, say(IMG.ceilingOnly));
    const rolled = bow(IMG.rolled), vRolled = cv.levelVerdict(rolled);
    c.ok("ROLLED 1.2° (no turn): the existing finding, rotated, the walls tipped with the lines", vRolled?.kind === "rotated" && Math.abs(vRolled.deg - 1.2) < 0.15 && Math.abs((rolled.roll ?? 0) - 1.2) < 0.15 && cv.turnedCamera(rolled) === null, say(IMG.rolled));
    c.ok("…rolled the other way: rotated", verdict(IMG.rolledBack)?.kind === "rotated", say(IMG.rolledBack));
    c.ok("a CORNER shot (two-point, on purpose): never flagged", verdict(IMG.corner) === null, say(IMG.corner));
    c.ok("a shallow corner, its ceiling lines sloping 2.4° either side of the corner: never flagged (opposite slopes at the same height, not above and below)", verdict(IMG.shallowCorner) === null, say(IMG.shallowCorner));
    c.ok("…and turned 3° as well: still a corner shot, never flagged", verdict(IMG.shallowCornerTurned) === null, say(IMG.shallowCornerTurned));
    c.ok("the camera-frame drill's \"lines meeting off the right edge\": what Jordan means, turned right", verdict(IMG.meetRight)?.kind === "turned" && (verdict(IMG.meetRight) as { side?: string }).side === "right", say(IMG.meetRight));
    c.ok("…its rolled camera (both lines 1.2° the same way): rotated, as before", verdict(IMG.sameWay)?.kind === "rotated", say(IMG.sameWay));
    // Shapes from the calibration photos (job:photo in the comment), as measured lines.
    const A = (deg: number, y: number, x0: number, x1: number) => ({ deg, y, x0, x1, len: x1 - x0 });
    c.ok("one sloping line over the counter beside a level soffit just above it (1680 Bridle Path kitchen): not one edge, not a turn", cv.turnedCamera({ roll: 0, across: [A(0.65, 0.298, 0.304, 0.713), A(0, 0.279, 0.358, 0.747)] }) === null);
    c.ok("one ceiling line off to one side of the photo (265 Mill Rd kitchen, a beam across an open room): not a turn", cv.turnedCamera({ roll: -0.15, across: [A(-0.51, 0.235, 0.066, 0.605)] }) === null);
    c.ok("the same line centred on the back wall: turned", cv.turnedCamera({ roll: -0.15, across: [A(-0.51, 0.235, 0.3, 0.72)] })?.side === "left");
    c.ok("…but not when the walls could not be measured (one side only could be a rotation)", cv.turnedCamera({ roll: null, across: [A(-0.51, 0.235, 0.3, 0.72)] }) === null);
    c.ok("a tub edge sloping under a level shower rod: the tub is not square, the camera is", cv.turnedCamera({ roll: 0, across: [A(0.7, 0.75, 0.25, 0.75), A(0.6, 0.8, 0.25, 0.75), A(0, 0.22, 0.25, 0.75)] }) === null);
    c.ok("lines along the side of a frame (washer, the photo's own edge rows): never counted", cv.turnedCamera({ roll: 0, across: [A(-0.8, 0.2, 0.0, 0.3), A(0.8, 0.8, 0.7, 1.0), A(-0.9, 0.02, 0.2, 0.8), A(0.9, 0.98, 0.2, 0.8)] }) === null);
    c.ok("slopes past 3° (a staircase, a corner's walls): never fitted", cv.turnedCamera({ roll: 0, across: [A(-3.5, 0.2, 0.2, 0.8), A(3.5, 0.8, 0.2, 0.8)] }) === null);

    // ======================================================================
    c.head("2 · the words: which way, and a fix that is not Crop & Tilt");
    const base = { lines: 10, tilt: 0, bent: 0, bow: 0, crooked: false, warped: false, words: "", hl: 2, lv: 0.6, lvn: 2 };
    const wl = geometry.levelWords({ ...base, turn: "left" }), wr = geometry.levelWords({ ...base, turn: "right" });
    c.ok("turned left, in plain words", /ceiling line runs downhill to the left and its floor line downhill to the right \(0\.6°\), so the camera was turned a little to the left/.test(wl), wl);
    c.ok("turned right, the mirror", /ceiling line runs downhill to the right and its floor line downhill to the left/.test(wr) && /turned a little to the right/.test(wr), wr);
    c.ok("rotated keeps its words", geometry.levelWords(base) === "2 long horizontal lines slope 0.6° the same way");
    c.ok("the fix for a turn: not Crop & Tilt (why), Lightroom's horizontal perspective then Replace with an upload, or another photo; coaching for the photographer", /Crop & Tilt will not fix this: turning the photo levels one of the back wall's lines and tips the other/.test(geometry.TURN_FIX) && /Lightroom \(Transform, Horizontal\)/.test(geometry.TURN_FIX) && /Replace with an upload/.test(geometry.TURN_FIX) && /another photo/.test(geometry.TURN_FIX) && /Coaching for the photographer: face the back wall square on/.test(geometry.TURN_FIX));
    c.ok("the rule's usual fix (fix cart, plan notes) still levels a rotation with Crop & Tilt, and says a turn is different", /^Level it in AutoHDR with Crop & Tilt/.test(policy.AUTOHDR_FREE_FIX.PERSP_HORIZONTAL_DISTORTION) && /slope opposite ways \(the camera was turned left or right, not tilted\)/.test(policy.AUTOHDR_FREE_FIX.PERSP_HORIZONTAL_DISTORTION));
    c.ok("no em or en dashes anywhere in it", ![wl, wr, geometry.TURN_FIX, policy.AUTOHDR_FREE_FIX.PERSP_HORIZONTAL_DISTORTION].some((t) => DASH.test(t)));
    c.ok("the check and a turn agree even when no line is long enough for the rotation measure", geometry.measuredVerdict("PERSP_HORIZONTAL_DISTORTION", { m: { ...base, hl: 1, turn: "left" } }) === "agree");
    c.ok("…level lines still disagree, too few still cannot tell", geometry.measuredVerdict("PERSP_HORIZONTAL_DISTORTION", { m: { ...base, lv: null, lvn: 0, hl: 3 } }) === "disagree" && geometry.measuredVerdict("PERSP_HORIZONTAL_DISTORTION", { m: { ...base, lv: null, lvn: 0, hl: 1 } }) === "unmeasured");

    // ======================================================================
    c.head("3 · end to end (geometry.ts)");
    await savePhotoDeliverySettings({ enabled: true, warpCv: true, warpCompareOriginal: false }, "drill");
    const floor = (await photoDeliverySettings()).displayConfidenceFloor;
    const pixels = new Map<string, Buffer>();
    S.__setPhotoBytesLoaderForTests(async (p) => {
      const b = pixels.get(p.name);
      if (!b) throw new S.PhotoSourceError("no drill bytes", "gone", "no drill bytes");
      return b;
    });
    const client = await prisma.client.create({ data: { name: "Yaw Client" } });
    const project = await prisma.project.create({ data: { title: "12 Square St, Reading, PA", addressLine: "12 Square St", clientId: client.id } });
    const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "QC_REVIEW" } });
    const shots: [string, string, Uint8Array][] = [
      ["bed.jpg", "BEDROOM", IMG.left],
      ["living.jpg", "LIVING", IMG.right],
      ["bath.jpg", "BATHROOM", IMG.rolled],
      ["kitchen.jpg", "KITCHEN", IMG.corner],
      ["front.jpg", "EXTERIOR_FRONT", IMG.left],
      ["dining.jpg", "DINING", IMG.square],
    ];
    const photos: { id: string }[] = [];
    for (const [i, [name, roomType, img]] of shots.entries()) {
      pixels.set(name, await jpeg(img));
      photos.push(await prisma.photoAsset.create({ data: { jobId: job.id, name, sourceKind: "ARYEO", sourceUrl: `https://cdn.aryeo.com/listings/yaw/${name}`, sourceRef: `img-${i}`, contentHash: `yaw${i}`, sequence: i, status: "ACTIVE", roomType } }));
    }
    const run = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "drill", checksJson: "{}" } });
    // The free check named the living room's ceiling line (minor, its usual weight).
    const named = await prisma.photoQcFinding.create({ data: { qcRunId: run.id, jobId: job.id, photoId: photos[1].id, ruleId: "PERSP_HORIZONTAL_DISTORTION", groupKey: "HORIZONTAL_PERSPECTIVE", pass: "P1_PHOTO", source: "AHDR", arbitration: "CONFIRMED", specificIssue: "The ceiling line slopes", explanation: "The line where the back wall meets the ceiling is not level.", severity: "MINOR", confidence: 0.7, responsibility: "EDITOR", fixStrategy: "HUMAN_REVIEW", contentHash: "yaw1" } });
    const r1 = await geometry.geometryJob(job.id, run.id, Date.now() + 120_000);
    c.ok("all 6 photos measured", r1.done && r1.measured === 6, JSON.stringify(r1));
    const level = await prisma.photoQcFinding.findMany({ where: { jobId: job.id, ruleId: "PERSP_HORIZONTAL_DISTORTION" } });
    const of = (i: number, source: string) => level.find((f) => f.photoId === photos[i].id && f.source === source);
    const bed = of(0, "CV");
    c.ok("the bedroom, turned left, measured alone: MINOR but shown, says which way", bed?.severity === "MINOR" && (bed?.confidence ?? 0) >= floor && bed?.specificIssue === "Measured: the camera was turned a little to the left (the back wall's lines slope 1.1°)", `${bed?.severity} ${bed?.confidence} ${bed?.specificIssue}`);
    c.ok("…with what to look at and the fix for a turn, the editor's", /room shot straight on with the camera turned: the back wall's ceiling line runs downhill to the left/.test(bed?.explanation ?? "") && /not Crop & Tilt/.test(bed?.explanation ?? "") && bed?.recommendedAction === geometry.TURN_FIX && bed?.responsibility === "EDITOR" && JSON.parse(bed?.coercedJson ?? "{}").turned === "left", bed?.explanation);
    const liv = await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: named.id } });
    c.ok("the living room, turned right, and the free check named it: MAJOR, the measurement in its words, the turn's fix", liv.severity === "MAJOR" && liv.confidence >= 0.85 && /Measured too: the back wall's ceiling line runs downhill to the right .*turned a little to the right\./.test(liv.explanation) && liv.recommendedAction === geometry.TURN_FIX && !of(1, "CV"), `${liv.severity} ${liv.confidence} ${liv.explanation}`);
    const bath = of(2, "CV");
    c.ok("the bathroom, rolled: the existing finding, Crop & Tilt", bath?.severity === "MINOR" && bath?.specificIssue === "Measured: horizontal lines slope 1.2°" && /Crop & Tilt/.test(bath?.recommendedAction ?? "") && bath?.recommendedAction !== geometry.TURN_FIX, `${bath?.specificIssue} ${bath?.recommendedAction}`);
    c.ok("the corner shot, the outside of the house and the room faced square: nothing", !of(3, "CV") && !of(4, "CV") && !of(5, "CV"));
    const prog = (await import("@/lib/photoDelivery/autohdrCheck")).readProgress((await prisma.photoQcRun.findUniqueOrThrow({ where: { id: run.id } })).checksJson);
    const geo = prog.geometry as Record<string, { m?: { turn?: string; lv?: number | null } }>;
    c.ok("kept with the run: the way it was turned, for the outside photo too (just not filed)", geo[photos[0].id]?.m?.turn === "left" && geo[photos[1].id]?.m?.turn === "right" && geo[photos[4].id]?.m?.turn === "left" && geo[photos[2].id]?.m?.turn === undefined && geo[photos[2].id]?.m?.lv != null);
    const r2 = await geometry.geometryJob(job.id, run.id, Date.now() + 120_000);
    const cvAll = await prisma.photoQcFinding.findMany({ where: { jobId: job.id, source: "CV" }, select: { ruleId: true, photoId: true } });
    c.ok("nothing measured or filed twice", r2.measured === 0 && cvAll.filter((f) => f.ruleId === "PERSP_HORIZONTAL_DISTORTION").length === 2, JSON.stringify({ r2, cv: cvAll.map((f) => `${f.ruleId} ${shots[photos.findIndex((p) => p.id === f.photoId)]?.[0]}`) }));

    c.head("isolation");
    S.__setPhotoBytesLoaderForTests(null);
    c.ok("nothing left the hub", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
