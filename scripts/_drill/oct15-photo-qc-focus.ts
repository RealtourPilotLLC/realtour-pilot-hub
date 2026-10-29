// ---------------------------------------------------------------------------
// DRILL: PHOTO QC FOCUSED ON WARPS AND CLUTTER (Oct 15 2026).
//
// Jordan: "For Photo QC, the biggest thing I need is making sure images are not
// warped or cluttered. I don't need to know about clutter in an already
// cluttered house, but if it looks like its been taken care of ... a random
// broom by the door, or a toilet seat is open, or a door mat is crooked, or if
// its vacant and relatively empty and there is random clutter there ... I want
// to focus on removing things from properties where they took the time to
// prepare, not the ones that are dumps like Nehemiah's shoots." And 2236
// Gregory Dr: a roof cut off by editing, no photo of the primary shower, and a
// listing replaced after delivery that the hub never looked at.
//
//   1. the measured line check (qc/cv.ts lineGeometry) on synthetic images
//   2. the free check's question v3: prep, features, "look for" words, the
//      removable-things rule, warped architecture; the five switched-off
//      checks stay out; never "fisheye"
//   3. prepared or not (prep.ts): the shoot decision and the room-level gate
//   4. a prepared home end to end: clutter kept only in rooms that look ready,
//      trash always, the Original comparison (roof: the edit; warp: the lens),
//      nothing measured that would cost a credit, the plan, room coverage
//      (the shower only in the background is advisory, a room left in AutoHDR)
//   5. as-is homes: a listed client and a lived-in home; nothing shown or
//      counted; the owner's override both ways; learning ignores the hub
//   6. a vacant home and measured warps: agree, disagree, measurement only
//   7. coverage: never shot, lost in editing, the delivery checklist, Accept
//      with reason, and the pure cases (unknown, condo, bathrooms)
//   8. after delivery (Gregory): the listing replaced, old findings set aside,
//      new photos matched and checked, Kyle and Jordan told, still delivered
// ISOLATION: PGlite; AutoHDR, Aryeo and Slack are fakes; anything else is
// refused and counted. No paid AutoHDR call.
// ---------------------------------------------------------------------------
import sharp from "sharp";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { createFakeAutohdr } from "./_fake-autohdr";

installNextStubs();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fake = createFakeAutohdr({ transforms: [{ name: "reedit", credit_cost: 1 }, { name: "autoremove", credit_cost: 1, requires_mask: true }, { name: "declutter", credit_cost: 1 }, { name: "style", credit_cost: null }], models: [{ id: 6, name: "Twilight Golden", type: "predefined", variant: "outdoor", style_credit_cost: 1 }], balance: 200, clientId: "cid", clientSecret: "drill-secret-1234567890" });

// The Aryeo listings by id (section 8), and the CDN.
const listings = new Map<string, { images: { id: string; filename: string; original_url: string; index: number }[]; delivered: boolean }>();
const fence = fenceFetch(async (url, init) => {
  const viaFake = await fake.handle(url, init);
  if (viaFake) return viaFake;
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: "D1", ts: "1" });
  const m = /^https:\/\/api\.aryeo\.com\/v1\/listings\/([^/?]+)/.exec(url);
  if (m) {
    const l = listings.get(m[1]);
    if (!l) return json({ message: "not found" }, 404);
    return json({ data: { id: m[1], delivery_status: l.delivered ? "DELIVERED" : "NOT_DELIVERED", type: "SINGLE_FAMILY", building: { bedrooms: 3, bathrooms: 2 }, images: l.images.map((i) => ({ ...i, large_url: i.original_url, display_in_gallery: true })) } });
  }
  if (url.startsWith("https://cdn.aryeo.com/")) {
    // Every listing photo ends like a complete JPEG (the cut-off upload check).
    const b = new Uint8Array(64);
    b[62] = 0xff;
    b[63] = 0xd9;
    return new Response(b, { status: 206, headers: { "content-range": "bytes 0-63/64" } });
  }
  return null;
});

// ---- synthetic photos (1024 x 683 luma, dark lines on a light wall) ----------------------------
const W = 1024, H = 683;
function draw(lines: ((y: number) => number)[], horiz: ((x: number) => number)[] = []): Uint8Array {
  const l = new Uint8Array(W * H).fill(200);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 200;
    for (const f of lines) { const d = Math.abs(x - f(y)); if (d < 3) v = Math.min(v, 60); else if (d < 4) v = Math.min(v, 60 + (d - 3) * 140); }
    for (const f of horiz) { const d = Math.abs(y - f(x)); if (d < 3) v = Math.min(v, 60); else if (d < 4) v = Math.min(v, 60 + (d - 3) * 140); }
    l[y * W + x] = v;
  }
  return l;
}
const XS = [80, 180, 280, 380, 480, 580, 680, 780, 880, 960];
const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
const IMG = {
  straight: draw(XS.map((x0) => () => x0), [() => 100, () => 600]),
  tilted: draw(XS.map((x0) => (y: number) => x0 + (y - H / 2) * tan(3))),
  bent: draw(XS.map((x0) => (y: number) => x0 + 0.00012 * (y - H / 2) ** 2 * (x0 < W / 2 ? -1 : 1)), [(x) => 100 + 0.00008 * (x - W / 2) ** 2]),
  few: draw([() => 300, () => 700]),
  // A ceiling line bowed across the room (nothing crossing it).
  bentCeiling: draw([], [(x) => 300 + 0.00008 * (x - W / 2) ** 2]),
};
const jpeg = (l: Uint8Array) => sharp(Buffer.from(l), { raw: { width: W, height: H, channels: 1 } }).jpeg({ quality: 95 }).toBuffer();

// ---- the free check's answers by AutoHDR photo name --------------------------------------------
type Answer = { room: string; prep?: string; furnished?: string; features?: string[]; issues?: { id: string; where: string; confidence: number }[] };
const answers = new Map<string, Answer>();
/** Original comparison answers: by photo name. */
const originals = new Map<string, { whole?: boolean; bent?: boolean }>();
/** Rooms of AutoHDR photos never delivered (coverage). */
const capturedRooms = new Map<string, { room: string; features?: string[] }>();
const asked: { name: string; kind: string; version: string }[] = [];
fake.state.describe = (name, prompt, version) => {
  if (/\nIds:\n/.test(prompt)) {
    asked.push({ name, kind: "check", version });
    const a = answers.get(name);
    return a ? JSON.stringify({ light: "day", furnished: a.furnished ?? "furnished", features: [], issues: [], ...a }) : '{"room":"other","issues":[]}';
  }
  if (/really visible/.test(prompt)) {
    asked.push({ name, kind: "second", version });
    return `{"items":[${prompt.split("\n").filter((l) => /^\d+\. /.test(l)).map((_, i) => `{"n":${i + 1},"present":true}`).join(",")}]}`;
  }
  if (/"whole": true or false/.test(prompt) || /"bent": true or false/.test(prompt)) {
    asked.push({ name, kind: "original", version });
    return JSON.stringify(originals.get(name) ?? {});
  }
  if (/"room":"<room type>","features"/.test(prompt)) {
    asked.push({ name, kind: "room", version });
    return JSON.stringify(capturedRooms.get(name) ?? { room: "other", features: [] });
  }
  asked.push({ name, kind: "other", version });
  return "A room.";
};

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7015) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { savePhotoDeliverySettings, photoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const cv = await import("@/lib/photoDelivery/qc/cv");
    const check = await import("@/lib/photoDelivery/autohdrCheck");
    const prep = await import("@/lib/photoDelivery/prep");
    const policy = await import("@/lib/photoDelivery/fixPolicy");
    const geometry = await import("@/lib/photoDelivery/geometry");
    const coverage = await import("@/lib/photoDelivery/coverage");
    const delivery = await import("@/lib/photoDelivery/delivery");
    const house = await import("@/lib/photoDelivery/houseRules");
    const S = await import("@/lib/photoDelivery/qc/source");
    await saveSecret("autohdr", "drill-secret-1234567890", { accountLabel: "drill", metadata: { clientId: "cid" } });
    await saveSecret("aryeo", "drill-aryeo-key", { accountLabel: "drill" });
    const owner = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "owner-focus@example.test" } });
    await prisma.appUser.create({ data: { email: "owner-focus@example.test", role: "OWNER", status: "ACTIVE", teamMemberId: owner.id } });
    await savePhotoDeliverySettings({ enabled: true, freeCheck: true, autoFix: true, fixRunnerEnabled: true, qcShadow: true, fixTargetUsd: 5, fixMaxUsd: 10 }, "drill");
    // Jordan's five house-wide switched-off checks (Oct 14).
    for (const r of ["GAL_RESOLUTION_CONSISTENCY", "KIT_CABINET_COLOR_ACROSS_PHOTOS", "PERSP_STRETCHED_EDGE_FURNITURE", "PERSP_EXCESSIVE_FISHEYE", "COMP_MOTION_BLUR"]) await house.stopRule(r, "Jordan does not need to know about this", "Jordan Spackman");

    // Pixels for the measured check: by photo name, through the hub's own loader (Aryeo photos).
    const pixels = new Map<string, Buffer>();
    S.__setPhotoBytesLoaderForTests(async (p) => {
      const b = pixels.get(p.name);
      if (!b) throw new S.PhotoSourceError("no drill bytes", "gone", "no drill bytes");
      return b;
    });

    let seq = 0;
    const mkJob = async (street: string, rooms: string[], opts: { clientName?: string; stage?: string; expected?: Record<string, unknown>; extraInAutohdr?: string[]; source?: "AUTOHDR" | "ARYEO" } = {}) => {
      const client = await prisma.client.create({ data: { name: opts.clientName ?? `Client ${street}` } });
      const project = await prisma.project.create({ data: { title: `${street}, Reading, PA`, addressLine: street, clientId: client.id } });
      const key = street.split(" ")[0];
      const shoot = fake.seedShoot({ address: street, photos: [...rooms.map((_, i) => ({ name: `${key}-${i + 1}.jpg`, downloaded: false })), ...(opts.extraInAutohdr ?? []).map((n) => ({ name: n, downloaded: false }))] });
      const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: opts.stage ?? "EDITED", autohdrPhotoshootId: shoot.photoshoot_id, autohdrCreatedAt: new Date(), expectedJson: JSON.stringify({ requestedFeatures: [], source: {}, ...(opts.expected ?? {}) }) } });
      const photos = [];
      for (let i = 0; i < rooms.length; i++) {
        const ph = shoot.photos[i];
        const aryeo = opts.source === "ARYEO";
        photos.push(await prisma.photoAsset.create({
          data: aryeo
            ? { jobId: job.id, name: ph.name, sourceKind: "ARYEO", sourceUrl: `https://cdn.aryeo.com/listings/${key}/${i + 1}.jpg`, sourceRef: `img-${key}-${i + 1}`, autohdrImageUuid: ph.image_uuid, autohdrVersionUuid: ph.head, contentHash: `c${seq++}`, sequence: i, status: "ACTIVE" }
            : { jobId: job.id, name: ph.name, sourceKind: "AUTOHDR", sourceRef: `${shoot.photoshoot_id}/${ph.image_uuid}`, autohdrImageUuid: ph.image_uuid, autohdrVersionUuid: ph.head, contentHash: `c${seq++}`, sequence: i, status: "ACTIVE" },
        }));
      }
      return { job, photos, shoot, client, project };
    };
    const runCheck = async (jobId: string) => {
      for (let i = 0; i < 4; i++) {
        const r = await check.driveAutohdrChecks({ budgetMs: 60_000, maxJobs: 5 });
        if (r.jobs.some((j) => j.jobId === jobId && j.finished)) return true;
      }
      return false;
    };
    const findingsOf = (jobId: string) => prisma.photoQcFinding.findMany({ where: { jobId, status: { not: "SUPERSEDED" } }, orderBy: { createdAt: "asc" } });
    const downloads = () => fake.state.calls.filter((x) => x.method === "POST" && x.path.endsWith("/photos/download")).length;

    // ======================================================================
    c.head("1 · the measured line check (pure)");
    const g = Object.fromEntries(Object.entries(IMG).map(([k, l]) => [k, cv.lineGeometry(l, W, H)])) as Record<keyof typeof IMG, import("@/lib/photoDelivery/qc/cv").LineGeometry>;
    c.ok("straight walls: neither crooked nor warped", !g.straight.crooked && !g.straight.warped && g.straight.verticalLines >= 8 && (g.straight.tiltDeg ?? 9) < 0.5, JSON.stringify({ ...g.straight, bent: g.straight.bent.length }));
    c.ok("verticals leaning 3°: crooked, measured near 3°", g.tilted.crooked && !g.tilted.warped && Math.abs((g.tilted.tiltDeg ?? 0) - 3) < 0.3, String(g.tilted.tiltDeg));
    c.ok("bowed walls: warped (bent lines found, with where)", g.bent.warped && g.bent.bentLines >= 2 && g.bent.bent.every((b) => b.nx >= 0 && b.nx <= 1 && b.ny >= 0 && b.ny <= 1), `${g.bent.bentLines} bent, bow ${g.bent.maxBowPx}px`);
    c.ok("a bowed ceiling line: found the other way round (horizontal lines)", g.bentCeiling.warped && g.bentCeiling.bent.every((b) => b.dir === "h"), `${g.bentCeiling.bentLines} bent, bow ${g.bentCeiling.maxBowPx}px`);
    c.ok("two lines only: not judged crooked, says why", !g.few.crooked && !!g.few.skipped && /needs 8/.test(g.few.skipped), g.few.skipped ?? "");
    c.ok("the words for a finding", /measured, leaning 3\.0°/.test(cv.geometryWords(g.tilted)) && /no bent lines/.test(cv.geometryWords(g.tilted)));
    const viaJpeg = await geometry.measureBytes(await jpeg(IMG.bent));
    c.ok("measured from a JPEG the same way (the hub's decoder, about 1024 px)", viaJpeg.warped && viaJpeg.width <= 1024, `${viaJpeg.bentLines} bent`);

    // ======================================================================
    c.head("2 · the free check's question, v3");
    const off = house.disabledIn(await house.houseOverrides());
    const q = check.checkPrompt(off);
    // Oct 22 2026: v4 adds floating objects (oct22-delivery-holds); everything below is v3's and still holds.
    c.ok("version 3 or later", check.CHECK_PROMPT_VERSION >= 3);
    c.ok("asks how ready each room looks, and what it shows", /"prep":"staged\|tidy\|lived_in\|cluttered\|empty"/.test(q) && /features: only these/.test(q) && /shower_in_background/.test(q));
    c.ok("names what to look for: the broom, the toilet seat, the door mat, shoes, remotes, cords, hoses, bins outside", ["broom, mop, dustpan", "toilet seat or lid left up", "door mat crooked", "shoes or boots", "TV remotes", "loose cords", "garden hose", "bins outside"].every((w) => q.includes(w)));
    c.ok("only what a photographer could have moved out of the frame", /only things a photographer could have moved out of the frame/.test(q));
    c.ok("warped architecture asked, never furniture, never the word fisheye", /PERSP_EDIT_WARP: walls, door frames, windows or cabinets that look bent/.test(q) && !/fisheye/i.test(q) && /never furniture/.test(q));
    c.ok("the five switched-off checks stay out", ["GAL_RESOLUTION_CONSISTENCY", "KIT_CABINET_COLOR_ACROSS_PHOTOS", "PERSP_STRETCHED_EDGE_FURNITURE", "PERSP_EXCESSIVE_FISHEYE", "COMP_MOTION_BLUR"].every((id) => !q.includes(id)));
    c.ok("the kitchen trash can is asked, and is a trash can (always fixed)", /KIT_GARBAGE_CANS: a kitchen trash/.test(q) && policy.fixClass("KIT_GARBAGE_CANS") === "always");
    const parsed = check.parseCheckAnswer('{"room":"kitchen","prep":"Lived in","features":["Shower","jacuzzi","tub_in_background"],"issues":[{"id":"PREP_DOOR_MAT_CROOKED","where":"front door","confidence":0.8}]}', off);
    c.ok("the answer: prep read (lived in → lived_in), features kept only from the list", parsed?.prep === "lived_in" && JSON.stringify(parsed.features) === '["shower","tub_in_background"]' && parsed.issues[0]?.ruleId === "PREP_DOOR_MAT_CROOKED", JSON.stringify(parsed));
    c.ok("the new checks are clutter the plan may fix (door mat, item left in an empty room); warps are free in AutoHDR", policy.fixClass("PREP_DOOR_MAT_CROOKED") === "prep" && policy.fixClass("PREP_LEFTOVER_ITEM_VACANT") === "prep" && policy.fixClass("PERSP_EDIT_WARP") === "autohdr" && /square to the door/.test(policy.instructionFor("PREP_DOOR_MAT_CROOKED", "front porch")));

    // ======================================================================
    c.head("3 · prepared or not (pure)");
    const ph = (room: string, p: string | null, furnished?: string) => ({ room: room as never, prep: p, furnished });
    const d = prep.decidePrepMode;
    c.ok("a client on the as-is list: as-is", d({ listed: true, photos: [ph("KITCHEN", "staged")] }).mode === "AS_IS");
    c.ok("2 of 5 rooms lived in or cluttered (40%): as-is", d({ listed: false, photos: [ph("KITCHEN", "tidy"), ph("LIVING", "lived_in"), ph("BEDROOM", "cluttered"), ph("BATHROOM", "tidy"), ph("DINING", "staged")] }).mode === "AS_IS");
    c.ok("1 of 5 lived in (20%): prepared", d({ listed: false, photos: [ph("KITCHEN", "tidy"), ph("LIVING", "lived_in"), ph("BEDROOM", "staged"), ph("BATHROOM", "tidy"), ph("DINING", "staged")] }).mode === "PREPARED");
    c.ok("4 of 6 rooms empty: vacant (furnished=empty counts when prep is missing)", d({ listed: false, photos: [ph("KITCHEN", "empty"), ph("LIVING", null, "empty"), ph("BEDROOM", "empty"), ph("BATHROOM", "tidy"), ph("DINING", "empty"), ph("OFFICE", "tidy")] }).mode === "VACANT");
    c.ok("exteriors never count; under 3 rated rooms: no decision", d({ listed: false, photos: [ph("EXTERIOR_FRONT", "cluttered"), ph("YARD", "cluttered"), ph("KITCHEN", "tidy"), ph("LIVING", "tidy")] }).mode === null);
    const G = prep.gateFor;
    c.ok("as-is: clutter set aside with the reason; trash, cars, camera, privacy and warps never", G({ ruleId: "BATH_TOILET_SEAT_OPEN", confidence: 0.9 }, "AS_IS", "tidy")?.reason === "As-is home: clutter not checked" && ["EXT_TRASH_CANS_PRIMARY", "KIT_GARBAGE_CANS", "EXT_PARKED_CARS_DRIVEWAY", "REFL_PHOTOGRAPHER_IN_MIRROR", "PREP_PERSONAL_DOCUMENTS", "PERSP_EDIT_WARP", "PERSP_AUTOHDR_ROOF_PEAKS_CROPPED"].every((r) => G({ ruleId: r, confidence: 0.9 }, "AS_IS", "cluttered") === null));
    c.ok("a prepared home: a lived-in room's clutter is its state; a tidy room's broom counts", G({ ruleId: "PREP_CLEANING_SUPPLIES", confidence: 0.9 }, "PREPARED", "lived_in")?.by === prep.GATE_BY.room && G({ ruleId: "PREP_CLEANING_SUPPLIES", confidence: 0.9 }, "PREPARED", "tidy") === null && G({ ruleId: "PREP_CLEANING_SUPPLIES", confidence: 0.9 }, null, null) === null);
    c.ok("an item left behind counts only in an empty room, at 70% sure or more", G({ ruleId: "PREP_LEFTOVER_ITEM_VACANT", confidence: 0.9 }, "VACANT", "tidy") !== null && G({ ruleId: "PREP_LEFTOVER_ITEM_VACANT", confidence: 0.6 }, "VACANT", "empty") !== null && G({ ruleId: "PREP_LEFTOVER_ITEM_VACANT", confidence: 0.75 }, "VACANT", "empty") === null);

    // ======================================================================
    c.head("4 · a prepared home, end to end");
    const A = await mkJob("40 Ready Ln", ["front", "kitchen", "living", "bath", "bed", "primary"], { expected: { bedrooms: 2, bathrooms: 1 }, extraInAutohdr: ["40-yard.jpg"] });
    answers.set("40-1.jpg", { room: "front exterior", prep: "tidy", issues: [{ id: "EXT_TRASH_CANS_PRIMARY", where: "curb, left", confidence: 0.9 }, { id: "PREP_DOOR_MAT_CROOKED", where: "front porch", confidence: 0.8 }, { id: "PERSP_AUTOHDR_ROOF_PEAKS_CROPPED", where: "top edge", confidence: 0.9 }] });
    answers.set("40-2.jpg", { room: "kitchen", prep: "tidy", issues: [{ id: "PREP_CLEANING_SUPPLIES", where: "broom by the back door", confidence: 0.85 }] });
    answers.set("40-3.jpg", { room: "living room", prep: "staged" });
    answers.set("40-4.jpg", { room: "primary bathroom", prep: "tidy", features: ["shower_in_background", "toilet", "vanity"], issues: [{ id: "BATH_TOILET_SEAT_OPEN", where: "toilet on the left", confidence: 0.9 }] });
    answers.set("40-5.jpg", { room: "bedroom", prep: "lived_in", issues: [{ id: "BED_CLOTHES_LEFT_OUT", where: "on the chair", confidence: 0.9 }] });
    answers.set("40-6.jpg", { room: "primary bedroom", prep: "tidy", issues: [{ id: "PERSP_EDIT_WARP", where: "left wall and window", confidence: 0.8 }] });
    originals.set("40-1.jpg", { whole: true });
    originals.set("40-6.jpg", { bent: true });
    capturedRooms.set("40-yard.jpg", { room: "rear exterior", features: [] });
    const dl0 = downloads();
    c.ok("the free check runs and finishes", await runCheck(A.job.id));
    const jA = await prisma.photoJob.findUniqueOrThrow({ where: { id: A.job.id } });
    const statsA = JSON.parse(jA.prepStatsJson ?? "{}") as { rated: number; livedIn: number; reason: string };
    c.ok("read as a prepared home (5 rooms rated, 1 lived in; the exterior does not count), by the hub", jA.prepMode === "PREPARED" && jA.prepModeBy === "auto" && statsA.rated === 5 && statsA.livedIn === 1, JSON.stringify(statsA));
    const pA = await prisma.photoAsset.findMany({ where: { jobId: A.job.id }, orderBy: { sequence: "asc" } });
    c.ok("each photo keeps how ready its room looked, and the features", pA.map((p) => p.prep).join() === "tidy,tidy,staged,tidy,lived_in,tidy" && JSON.parse(pA[3].featuresJson ?? "[]").includes("shower_in_background"));
    let fA = await findingsOf(A.job.id);
    const st = (rule: string) => fA.find((f) => f.ruleId === rule);
    c.ok("the clothes in the lived-in bedroom: set aside (room not prepared), by the hub", st("BED_CLOTHES_LEFT_OUT")?.status === "IGNORED" && st("BED_CLOTHES_LEFT_OUT")?.decidedBy === prep.GATE_BY.room && /not prepared/.test(st("BED_CLOTHES_LEFT_OUT")?.statusReason ?? ""));
    c.ok("the broom, the open toilet seat, the crooked door mat and the bins: open", ["PREP_CLEANING_SUPPLIES", "BATH_TOILET_SEAT_OPEN", "PREP_DOOR_MAT_CROOKED", "EXT_TRASH_CANS_PRIMARY"].every((r) => st(r)?.status === "OPEN"));
    c.ok("the door mat comes with its fix wording", /Straighten the door mat so it lies flat and square to the door.*\(front porch\)/.test(st("PREP_DOOR_MAT_CROOKED")?.reeditPrompt ?? ""));
    const pl0 = await policy.planAutoFix(A.job.id);
    c.ok("nothing is planned while the second look is still to run", !pl0.planned && /second look/.test(pl0.reason), pl0.reason);
    await policy.driveAutoFixPlanning({ budgetMs: 120_000 });
    const runA = await prisma.photoQcRun.findFirstOrThrow({ where: { jobId: A.job.id, trigger: "AUTOHDR_CHECK" }, orderBy: { startedAt: "desc" } });
    const progA = check.readProgress(runA.checksJson);
    c.ok("the measured check is done; the hub's own photos not bought yet are not measured, and say why", progA.geometryDone === true && Object.values(progA.geometry ?? {}).every((x) => /would cost a credit/.test(String((x as { skipped?: string }).skipped))), JSON.stringify(progA.geometry).slice(0, 200));
    c.ok("no download was made for it (nothing bought, no credit)", downloads() === dl0 && fake.state.balance === 200);
    fA = await findingsOf(A.job.id);
    const roof = st("PERSP_AUTOHDR_ROOF_PEAKS_CROPPED")!;
    const warp = st("PERSP_EDIT_WARP")!;
    const origAsks = asked.filter((x) => x.kind === "original");
    const origOf = (name: string) => fake.state.shoots.flatMap((s) => s.photos).find((p) => p.name === name)!.versions.find((v) => !v.parent)!.uuid;
    c.ok("the Original was asked about (its own version, not the edit), free", origAsks.some((x) => x.name === "40-1.jpg" && x.version === origOf("40-1.jpg")) && origAsks.some((x) => x.name === "40-6.jpg" && x.version === origOf("40-6.jpg")));
    c.ok("the roof: AutoHDR's original shows it whole → the editing cut it (EDITOR, Perspective Off)", roof.responsibility === "EDITOR" && /Perspective Off/.test(roof.recommendedAction ?? "") && /original shows the whole roof/.test(roof.explanation), roof.explanation);
    c.ok("the warp: the original is bent too → the lens (PHOTOGRAPHER, coaching)", warp.responsibility === "PHOTOGRAPHER" && /coaching/i.test(warp.recommendedAction ?? "") && /Not measured \(not downloaded/.test(warp.explanation), warp.explanation);
    c.ok("…and on the check's word alone (not measurable for free) it counts as minor", warp.severity === "MINOR" && warp.confidence <= 0.6);
    const cartA = await (await import("@/lib/photoDelivery/fixes")).buildFixCart(A.job.id);
    const roofLine = cartA.lines.find((l) => l.ruleId === "PERSP_AUTOHDR_ROOF_PEAKS_CROPPED");
    c.ok("the Fix Cart's free AutoHDR line says what the comparison found", roofLine?.humanCall === "autohdr-editor" && /Perspective Off on this photo/.test(roofLine.howTo ?? ""), roofLine?.howTo ?? "");
    const batchA = await prisma.photoFixBatch.findFirst({ where: { jobId: A.job.id, approvedBy: "auto-fix" } });
    const opsA = batchA ? await prisma.photoFixOperation.findMany({ where: { batchId: batchA.id } }) : [];
    const fixedIds = new Set(opsA.flatMap((o) => JSON.parse(o.findingIdsJson) as string[]));
    c.ok("planned after the measured check: bins, door mat, broom and toilet seat fixed; the clothes never", !!batchA && ["EXT_TRASH_CANS_PRIMARY", "PREP_DOOR_MAT_CROOKED", "PREP_CLEANING_SUPPLIES", "BATH_TOILET_SEAT_OPEN"].every((r) => fixedIds.has(st(r)!.id)) && !fixedIds.has(st("BED_CLOTHES_LEFT_OUT")!.id), `${opsA.length} ops`);
    const covA = coverage.parseCoverage((await prisma.photoJob.findUniqueOrThrow({ where: { id: A.job.id } })).coverageJson);
    const rowA = (k: string) => covA?.rooms.find((r) => r.key === k);
    c.ok("room coverage ran: front, kitchen, living, primary bedroom and bathroom in", ["front-exterior", "kitchen", "living", "primary-bedroom", "primary-bathroom"].every((k) => rowA(k)?.status === "DELIVERED"), JSON.stringify(covA?.rooms.map((r) => `${r.key}:${r.status}`)));
    c.ok("the rear yard is in AutoHDR but not in the delivery (one free look at it)", rowA("rear-exterior")?.status === "NOT_DELIVERED" && /40-yard\.jpg/.test(rowA("rear-exterior")?.note ?? "") && asked.filter((x) => x.kind === "room" && x.name === "40-yard.jpg").length === 1);
    const covFindings = fA.filter((f) => f.source === "COVERAGE");
    const shower = covFindings.find((f) => f.groupKey === "coverage-primary-shower");
    c.ok("Gregory's case: the shower only in the background → 'Primary shower has no photo of its own', MINOR, advisory", shower?.severity === "MINOR" && shower.specificIssue === "Primary shower has no photo of its own" && /only shows in the background of 40-4\.jpg/.test(shower.explanation), shower?.specificIssue ?? "none");
    const gateA = await delivery.deliveryGate(A.job.id);
    c.ok("the delivery checklist: rooms checked, and nothing minor blocks the coverage line", gateA.checks.find((x) => x.key === "rooms")?.ok === true && gateA.checks.find((x) => x.key === "coverage")?.ok === true, JSON.stringify(gateA.checks.map((x) => `${x.key}:${x.ok}`)));

    // ======================================================================
    c.head("5 · as-is homes: nothing about clutter shown or counted");
    const B = await mkJob("50 Lindo St", ["front", "kitchen", "bath"], { clientName: "Nehemiah Drill" });
    await savePhotoDeliverySettings({ asIsClientIds: [B.client.id] }, "drill");
    answers.set("50-1.jpg", { room: "front exterior", prep: "tidy", issues: [{ id: "EXT_TRASH_CANS_PRIMARY", where: "driveway", confidence: 0.9 }, { id: "EXT_GARDEN_HOSES", where: "lawn", confidence: 0.9 }] });
    answers.set("50-2.jpg", { room: "kitchen", prep: "tidy", issues: [{ id: "KIT_DISHES_ON_COUNTERS", where: "island", confidence: 0.9 }, { id: "KIT_GARBAGE_CANS", where: "by the fridge", confidence: 0.9 }] });
    answers.set("50-3.jpg", { room: "bathroom", prep: "tidy", features: ["shower"], issues: [{ id: "BATH_TOILET_SEAT_OPEN", where: "toilet", confidence: 0.9 }] });
    c.ok("checked", await runCheck(B.job.id));
    const fB = await findingsOf(B.job.id);
    const jB = await prisma.photoJob.findUniqueOrThrow({ where: { id: B.job.id } });
    c.ok("as-is: the client is on the list", jB.prepMode === "AS_IS" && /as-is list/.test(JSON.parse(jB.prepStatsJson ?? "{}").reason ?? ""));
    c.ok("dishes and toilet seat: 'As-is home: clutter not checked', set aside by the hub", ["KIT_DISHES_ON_COUNTERS", "BATH_TOILET_SEAT_OPEN"].every((r) => { const f = fB.find((x) => x.ruleId === r); return f?.status === "IGNORED" && f.statusReason === prep.AS_IS_REASON && f.decidedBy === prep.GATE_BY.asIs; }));
    // Oct 21 2026 (859 N Lawrence St, CHANGED): an as-is home is about the
    // rooms inside; the hose outside is never set aside by the gate.
    c.ok("…the hose outside is not: it stays open (oct21-photo-misses)", fB.find((x) => x.ruleId === "EXT_GARDEN_HOSES")?.status === "OPEN");
    c.ok("trash cans (outside and the kitchen's) still open: always wanted", ["EXT_TRASH_CANS_PRIMARY", "KIT_GARBAGE_CANS"].every((r) => fB.find((x) => x.ruleId === r)?.status === "OPEN"));
    const data = await import("@/app/ops/photo-delivery/data");
    const admin = { role: "ADMIN", name: "Kyle", isOwner: false, canSeeMoney: false };
    const viewB = await data.loadJobDetail(B.job.id, { viewer: admin });
    c.ok("the job page: the set-aside clutter is not listed; the count is said; the hose is listed", !!viewB && !viewB.findings.some((f) => ["KIT_DISHES_ON_COUNTERS", "BATH_TOILET_SEAT_OPEN"].includes(f.ruleId)) && viewB.findings.some((f) => f.ruleId === "EXT_GARDEN_HOSES") && viewB.prep.hiddenAsIs === 2 && viewB.prep.mode === "AS_IS");
    const { reviewStage } = await import("@/lib/photoDelivery/decisions");
    c.ok("never counted: the verdict sees the two trash cans and the hose outside", (await reviewStage(B.job.id)).open === 3);
    const C = await mkJob("60 Lived In Ave", ["kitchen", "living", "bed", "bath"]);
    answers.set("60-1.jpg", { room: "kitchen", prep: "cluttered", issues: [{ id: "KIT_EXCESSIVE_COUNTERTOP_ITEMS", where: "counters", confidence: 0.9 }] });
    answers.set("60-2.jpg", { room: "living room", prep: "lived_in", issues: [{ id: "LIV_REMOTE_CONTROLS", where: "coffee table", confidence: 0.9 }] });
    answers.set("60-3.jpg", { room: "bedroom", prep: "lived_in" });
    answers.set("60-4.jpg", { room: "bathroom", prep: "tidy", issues: [{ id: "BATH_TOILET_SEAT_OPEN", where: "toilet", confidence: 0.9 }] });
    c.ok("checked", await runCheck(C.job.id));
    const jC = await prisma.photoJob.findUniqueOrThrow({ where: { id: C.job.id } });
    c.ok("a lived-in home (3 of 4 rooms): as-is, said why", jC.prepMode === "AS_IS" && /3 of 4 rooms lived in or cluttered/.test(JSON.parse(jC.prepStatsJson ?? "{}").reason ?? ""), jC.prepStatsJson ?? "");
    const toPrepared = await prep.setPrepMode(C.job.id, "PREPARED", "Jordan Spackman");
    let fC = await findingsOf(C.job.id);
    const seat = () => fC.find((f) => f.ruleId === "BATH_TOILET_SEAT_OPEN")!;
    c.ok("Jordan sets it to prepared: the tidy bathroom's toilet seat is back; the lived-in rooms' clutter stays aside", toPrepared.ok && seat().status === "OPEN" && fC.find((f) => f.ruleId === "LIV_REMOTE_CONTROLS")?.status === "IGNORED" && fC.find((f) => f.ruleId === "LIV_REMOTE_CONTROLS")?.decidedBy === prep.GATE_BY.room, toPrepared.message);
    const jC2 = await prisma.photoJob.findUniqueOrThrow({ where: { id: C.job.id } });
    c.ok("his choice is kept (by him), and the next check leaves it", jC2.prepMode === "PREPARED" && jC2.prepModeBy === "Jordan Spackman" && (await prep.refreshPrepMode(C.job.id)).mode === "PREPARED");
    const back = await prep.setPrepMode(C.job.id, null, "Jordan Spackman");
    fC = await findingsOf(C.job.id);
    c.ok("back to automatic: as-is again, the toilet seat set aside again", back.ok && (await prisma.photoJobEvent.count({ where: { jobId: C.job.id, action: "home type back to automatic" } })) === 1 && seat().status === "IGNORED" && seat().decidedBy === prep.GATE_BY.asIs, back.message);
    const learned = await policy.learnedRules();
    c.ok("the hub's own set-asides never teach 'not worth fixing'", !learned.get("BATH_TOILET_SEAT_OPEN") && !learned.get("KIT_DISHES_ON_COUNTERS"));
    await policy.driveAutoFixPlanning({ budgetMs: 120_000 });
    const opsB = await prisma.photoFixOperation.findMany({ where: { jobId: B.job.id } });
    const planB = await prisma.photoQcFinding.findMany({ where: { jobId: B.job.id, status: "APPROVED_FIX" } });
    c.ok("the plan on the as-is home: only the trash cans", opsB.length === 2 && planB.every((f) => ["EXT_TRASH_CANS_PRIMARY", "KIT_GARBAGE_CANS"].includes(f.ruleId)), planB.map((f) => f.ruleId).join());

    // ======================================================================
    c.head("6 · a vacant home, and warps measured");
    const D = await mkJob("70 Empty Ct", ["living", "bed", "kitchen", "office", "dining"], { source: "ARYEO" });
    for (const [i, a] of [
      { room: "living room", prep: "empty", furnished: "empty", issues: [{ id: "PREP_LEFTOVER_ITEM_VACANT", where: "paint bucket by the window", confidence: 0.8 }] },
      { room: "bedroom", prep: "empty", furnished: "empty", issues: [{ id: "PREP_LEFTOVER_ITEM_VACANT", where: "bag in the corner", confidence: 0.6 }] },
      { room: "kitchen", prep: "empty", furnished: "empty", issues: [{ id: "PERSP_EDIT_WARP", where: "cabinets on the right", confidence: 0.7 }] },
      { room: "office", prep: "empty", furnished: "empty", issues: [{ id: "PERSP_CROOKED_VERTICALS", where: "door frame", confidence: 0.8 }] },
      { room: "dining room", prep: "empty", furnished: "empty" },
    ].entries()) answers.set(`70-${i + 1}.jpg`, a);
    pixels.set("70-1.jpg", await jpeg(IMG.straight));
    pixels.set("70-2.jpg", await jpeg(IMG.straight));
    pixels.set("70-3.jpg", await jpeg(IMG.bent));
    pixels.set("70-4.jpg", await jpeg(IMG.straight));
    pixels.set("70-5.jpg", await jpeg(IMG.bent));
    originals.set("70-3.jpg", { bent: false });
    originals.set("70-5.jpg", { bent: false });
    c.ok("checked", await runCheck(D.job.id));
    const jD = await prisma.photoJob.findUniqueOrThrow({ where: { id: D.job.id } });
    let fD = await findingsOf(D.job.id);
    const leftover = fD.filter((f) => f.ruleId === "PREP_LEFTOVER_ITEM_VACANT");
    c.ok("read as vacant (5 of 5 rooms empty)", jD.prepMode === "VACANT", jD.prepStatsJson ?? "");
    c.ok("an item left in an empty room at 80%: counts; at 60%: set aside (needs 70%)", leftover.find((f) => /paint bucket/.test(f.specificIssue))?.status === "OPEN" && leftover.find((f) => /bag in the corner/.test(f.specificIssue))?.status === "IGNORED", leftover.map((f) => `${f.status} ${f.statusReason}`).join(" | "));
    for (let i = 0; i < 3; i++) await policy.driveAutoFixPlanning({ budgetMs: 120_000 });
    fD = await findingsOf(D.job.id);
    const runD = await prisma.photoQcRun.findFirstOrThrow({ where: { jobId: D.job.id, trigger: "AUTOHDR_CHECK" }, orderBy: { startedAt: "desc" } });
    const progD = check.readProgress(runD.checksJson);
    c.ok("all 5 photos measured from the listing's own copies (free)", progD.geometryDone === true && Object.values(progD.geometry ?? {}).filter((x) => (x as { m?: unknown }).m).length === 5);
    const warpD = fD.find((f) => f.ruleId === "PERSP_EDIT_WARP" && f.source === "AHDR")!;
    c.ok("the check and the measurement agree on the bent cabinets: full weight (confidence raised), measured words added", warpD.severity === "MAJOR" && warpD.confidence >= 0.85 && /Measured too: .*bent/.test(warpD.explanation), `${warpD.severity} ${warpD.confidence}`);
    c.ok("…and the original was straight: the editing bent it (EDITOR, Perspective Off)", warpD.responsibility === "EDITOR" && /Perspective Off/.test(warpD.recommendedAction ?? ""));
    const leanD = fD.find((f) => f.ruleId === "PERSP_CROOKED_VERTICALS" && f.source === "AHDR")!;
    c.ok("the check says leaning, the lines measure straight: minor, with why", leanD.severity === "MINOR" && leanD.confidence <= 0.55 && /measured lines look straight/.test(leanD.explanation), `${leanD.severity} ${leanD.confidence}`);
    const onlyCv = fD.find((f) => f.source === "CV" && f.photoId === D.photos[4].id);
    c.ok("only the measurement saw the bent dining room: advisory, below the confidence floor (never blocks)", onlyCv?.ruleId === "PERSP_EDIT_WARP" && onlyCv.severity === "MINOR" && onlyCv.confidence < (await photoDeliverySettings()).displayConfidenceFloor && /Only the measured line check saw this/.test(onlyCv.explanation));
    const again = await geometry.geometryJob(D.job.id, runD.id, Date.now() + 60_000);
    c.ok("nothing is measured or filed twice", (await prisma.photoQcFinding.count({ where: { jobId: D.job.id, source: "CV" } })) === 1 && again.measured === 0);
    c.ok("pure: the Original's answer read both ways", geometry.originalVerdict("PERSP_AUTOHDR_ROOF_PEAKS_CROPPED", { whole: false })?.responsibility === "PHOTOGRAPHER" && geometry.originalVerdict("PERSP_EDIT_WARP", { bent: false })?.responsibility === "EDITOR" && geometry.originalVerdict("PERSP_EDIT_WARP", {}) === null);

    // ======================================================================
    c.head("7 · coverage: never shot, lost in editing, the checklist");
    const E = await mkJob("80 Short St", ["front", "living", "bath"], { expected: { bedrooms: 1, bathrooms: 1 } });
    // The hub's own intake: 50 bracket files (10 sets) went in, AutoHDR returned 3 (Oct 29 2026: a gap of 6 or more counts).
    const files = Array.from({ length: 50 }, (_, i) => ({ id: `id:${i}`, name: `DSC0${8000 + i}.JPG`, path: `/raw/DSC0${8000 + i}.JPG`, size: 9_000_000, hash: `h${i}` }));
    await prisma.photoIntakeBatch.create({ data: { projectId: E.project.id, batchNo: 1, state: "DONE", rawPath: "/raw", filesJson: JSON.stringify(files), fileCount: 50, fingerprint: "fp", expectedPhotos: 10, imageCount: 3, photoshootId: E.shoot.photoshoot_id, photosJson: JSON.stringify(E.shoot.photos.map((p) => ({ image_uuid: p.image_uuid, image_version_uuid: p.head, name: p.name }))), seenAt: new Date(), doneAt: new Date() } });
    answers.set("80-1.jpg", { room: "front exterior", prep: "tidy" });
    answers.set("80-2.jpg", { room: "living room", prep: "tidy" });
    answers.set("80-3.jpg", { room: "bathroom", prep: "tidy", features: ["shower", "toilet"] });
    c.ok("checked", await runCheck(E.job.id));
    const gate0 = await delivery.deliveryGate(E.job.id);
    c.ok("before the room check: the checklist says rooms not checked (the same-day delivery waits)", gate0.checks.find((x) => x.key === "rooms")?.ok === false && !gate0.passed);
    const covE1 = await coverage.coverageJob(E.job.id, Date.now() + 60_000);
    const fE = (await findingsOf(E.job.id)).filter((f) => f.source === "COVERAGE");
    const byG = (k: string) => fE.find((f) => f.groupKey === `coverage-${k}`);
    c.ok("the kitchen was never shot: PHOTOGRAPHER, MAJOR, and it may have been lost in editing", byG("kitchen")?.ruleId === "COVERAGE_ROOM_NOT_CAPTURED" && byG("kitchen")?.severity === "MAJOR" && byG("kitchen")?.responsibility === "PHOTOGRAPHER" && /lost in editing/.test(byG("kitchen")?.explanation ?? ""));
    c.ok("AutoHDR returned 3 photos for 10 bracket sets: EDITOR, MAJOR", byG("lost-in-edit")?.ruleId === "COVERAGE_PHOTOS_LOST_IN_EDIT" && byG("lost-in-edit")?.responsibility === "EDITOR" && /3 photos for 10 bracket sets/.test(byG("lost-in-edit")?.specificIssue ?? ""));
    // Oct 29 2026 (Kyle overrode every one: "Autohdr has 92", "Only 50 photos in autohdr"; 902 Valley Rd: 9 photos for 135 frames).
    const raw = (n: number, drone = 0) => [...Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `DSC${i}.JPG`, path: `/r/DSC${i}.JPG`, size: 1, hash: `r${i}` })), ...Array.from({ length: drone }, (_, i) => ({ id: `d${i}`, name: `DJI_${i}.JPG`, path: `/r/DJI_${i}.JPG`, size: 1, hash: `d${i}` }))];
    c.ok("pure: 92 back for 96 sets, 50 for 54, 80 for 85: AutoHDR's own count, not a loss", [[96, 92], [54, 50], [85, 80]].every(([sets, got]) => coverage.editLoss([{ batchNo: 1, files: raw(sets * 5), returned: got }]).length === 0));
    c.ok("pure: 9 back for 135 frames is 15 to a set (with 4 drone shots: 13), nothing lost", coverage.editLoss([{ batchNo: 1, files: raw(135), returned: 9 }]).length === 0 && coverage.editLoss([{ batchNo: 1, files: raw(135, 4), returned: 13 }]).length === 0);
    c.ok("pure: 40 back for 50 sets is still a loss", coverage.editLoss([{ batchNo: 1, files: raw(250), returned: 40 }])[0]?.expected === 50);
    c.ok("the shower has a photo of its own: no shower finding", !byG("primary-shower"));
    const gate1 = await delivery.deliveryGate(E.job.id);
    c.ok("the checklist: rooms checked, the coverage line open (blocks the automatic delivery)", gate1.checks.find((x) => x.key === "rooms")?.ok === true && gate1.checks.find((x) => x.key === "coverage")?.ok === false && !gate1.passed, `${covE1.findings} findings`);
    const { decideFindings } = await import("@/lib/photoDelivery/decisions");
    const blocking = fE.filter((f) => f.status === "OPEN" && f.severity !== "MINOR");
    const acc = await decideFindings({ jobId: E.job.id, findingIds: blocking.map((f) => f.id), status: "OVERRIDDEN", reason: "Kitchen is being renovated; the agent asked to leave it out", by: "Kyle" });
    c.ok("Accept with reason: the coverage line clears", acc.ok && (await delivery.deliveryGate(E.job.id)).checks.find((x) => x.key === "coverage")?.ok === true, acc.message);
    await prisma.photoJob.update({ where: { id: E.job.id }, data: { coverageJson: null } });
    const covE2 = await coverage.coverageJob(E.job.id, Date.now() + 60_000);
    c.ok("checked again: what a person accepted is never raised again", covE2.findings === 0 && (await prisma.photoQcFinding.count({ where: { jobId: E.job.id, source: "COVERAGE", status: "OPEN", severity: { not: "MINOR" } } })) === 0);
    const lab = (room: string | null, features: string[] = []) => ({ id: room ?? "x", name: `${room}.jpg`, room: room as never, features });
    const base = { bedrooms: 3, bathrooms: 2.5, propertyType: null, notDelivered: [], capturedComplete: true, unlabeledCaptured: 0, featuresKnown: true, lostInEdit: [] };
    const rowsU = coverage.assessCoverage({ ...base, capturedComplete: false, delivered: [lab("EXTERIOR_FRONT"), lab("LIVING"), lab("PRIMARY_BEDROOM"), lab("PRIMARY_BATHROOM", ["shower"])] });
    c.ok("pure: AutoHDR's photos unknown → the kitchen is 'not in the delivery' (cannot say never shot)", rowsU.find((r) => r.key === "kitchen")?.status === "UNKNOWN");
    c.ok("pure: 2.5 bathrooms and 1 bathroom photo → a minor note", rowsU.find((r) => r.key === "bathrooms")?.severity === "MINOR" && /2\.5 bathrooms on the listing, 1 bathroom photo/.test(rowsU.find((r) => r.key === "bathrooms")?.note ?? ""));
    const rowsCondo = coverage.assessCoverage({ ...base, propertyType: "condo", delivered: [lab("KITCHEN"), lab("LIVING"), lab("BEDROOM"), lab("BATHROOM", ["tub"]), lab("BATHROOM"), lab("POWDER_ROOM")] });
    c.ok("pure: a condo needs no rear exterior and its front exterior is minor", !rowsCondo.some((r) => r.key === "rear-exterior") && rowsCondo.find((r) => r.key === "front-exterior")?.severity === "MINOR");
    c.ok("pure: an older check (no features) never judges the shower", !coverage.assessCoverage({ ...base, featuresKnown: false, delivered: [lab("PRIMARY_BATHROOM")] }).some((r) => r.key === "primary-shower"));
    // Oct 29 2026 (58 Recreation Dr, drone and lot lines: Kyle "Exterior only").
    const rowsOut = coverage.assessCoverage({ ...base, exteriorOnly: true, delivered: [lab("EXTERIOR_FRONT"), lab("AERIAL")] });
    c.ok("pure: an exterior-only order expects the outside only (no kitchen, living area, bedroom or bathroom)", rowsOut.map((r) => r.key).join(",") === "front-exterior,rear-exterior", rowsOut.map((r) => r.key).join(","));
    c.ok("pure: which orders show the inside", !coverage.orderShowsInside([{ type: "DRONE" }, { type: "OTHER" }]) && !coverage.orderShowsInside([{ type: "TWILIGHT" }]) && coverage.orderShowsInside([{ type: "PHOTOS" }, { type: "DRONE" }]) && coverage.orderShowsInside([{ type: "VIRTUAL_STAGING" }, { type: "DRONE" }]) && coverage.orderShowsInside([]) && coverage.orderShowsInside([{ type: "SOCIAL_REEL" }]));

    // ======================================================================
    c.head("8 · after delivery: 2236 Gregory Dr's listing replaced");
    const jobs = await import("@/lib/photoDelivery/jobs");
    const client = await prisma.client.create({ data: { name: "Bernadette Drill" } });
    const projF = await prisma.project.create({ data: { title: "2236 Gregory Dr, Reading, PA", addressLine: "2236 Gregory Dr", clientId: client.id, aryeoListingId: "lst-greg" } });
    const shootF = fake.seedShoot({ address: "2236 Gregory Dr", photos: [{ name: "IMG_1.jpg" }, { name: "IMG_2.jpg" }, { name: "IMG_3.jpg" }] });
    const jobF = await prisma.photoJob.create({ data: { projectId: projF.id, stage: "READY", autohdrPhotoshootId: shootF.photoshoot_id, autohdrCreatedAt: new Date() } });
    listings.set("lst-greg", { delivered: false, images: [1, 2, 3].map((n) => ({ id: `g1-${n}`, filename: `Gregory (${n} of 3).jpg`, original_url: `https://cdn.aryeo.com/listings/greg/${n}.jpg`, index: n - 1 })) });
    await jobs.syncJobFinals(jobF.id, new Date());
    const { linkAutohdrShoot } = await import("@/lib/photoDelivery/autohdrLink");
    await linkAutohdrShoot(jobF.id);
    const firstRows = await prisma.photoAsset.findMany({ where: { jobId: jobF.id }, orderBy: { sequence: "asc" } });
    for (const r of firstRows) await prisma.photoAsset.update({ where: { id: r.id }, data: { inspectedHash: r.contentHash } });
    const oldRun = await prisma.photoQcRun.create({ data: { jobId: jobF.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", startedAt: new Date(Date.now() - 3 * 3_600_000), finishedAt: new Date(Date.now() - 3 * 3_600_000), checksJson: JSON.stringify({ done: {}, errors: {}, skipped: [], rooms: {} }) } });
    const oldFinding = await prisma.photoQcFinding.create({ data: { qcRunId: oldRun.id, jobId: jobF.id, photoId: firstRows[0].id, ruleId: "EXT_GARDEN_HOSES", groupKey: "GARDEN_HOSE", pass: "P1_PHOTO", source: "AHDR", specificIssue: "Garden hose", explanation: "x", severity: "MAJOR", confidence: 0.9, responsibility: "PHOTOGRAPHER", fixStrategy: "REEDIT_PROMPT", status: "OPEN" } });
    await prisma.photoJob.update({ where: { id: jobF.id }, data: { stage: "DELIVERED", stageChangedAt: new Date(Date.now() - 2 * 3_600_000), deliveredAt: new Date(Date.now() - 2 * 3_600_000) } });
    const expF = JSON.parse((await prisma.photoJob.findUniqueOrThrow({ where: { id: jobF.id } })).expectedJson ?? "{}") as { bedrooms?: number; bathrooms?: number; propertyType?: string; source?: Record<string, string> };
    c.ok("the listing's bedrooms, bathrooms and type reach the job (room coverage, the paid QC's beds and baths)", expF.bedrooms === 3 && expF.bathrooms === 2 && expF.propertyType === "single family" && expF.source?.bathrooms === "Aryeo listing", JSON.stringify(expF));
    // The listing is replaced after delivery ("Gregrory (N of 3)").
    listings.set("lst-greg", { delivered: true, images: [1, 2, 3].map((n) => ({ id: `g2-${n}`, filename: `Gregrory (${n} of 3).jpg`, original_url: `https://cdn.aryeo.com/listings/greg/v2-${n}.jpg`, index: n - 1 })) });
    await jobs.syncJobFinals(jobF.id, new Date());
    const rowsF = await prisma.photoAsset.findMany({ where: { jobId: jobF.id }, orderBy: { createdAt: "asc" } });
    const fresh = rowsF.filter((r) => r.status === "ACTIVE");
    c.ok("the old photos are gone, the new ones in, matched to AutoHDR's photos ('N of M', a free read)", rowsF.filter((r) => r.status === "GONE").length === 3 && fresh.length === 3 && fresh.every((r) => !!r.autohdrImageUuid && /Gregrory/.test(r.name)));
    const old = await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: oldFinding.id } });
    c.ok("the old photo's open finding is set aside (never counts)", old.status === "SUPERSEDED" && old.statusReason === "The photo is no longer in the gallery");
    answers.set("IMG_1.jpg", { room: "front exterior", prep: "tidy", issues: [{ id: "PERSP_AUTOHDR_ROOF_PEAKS_CROPPED", where: "top edge", confidence: 0.9 }] });
    answers.set("IMG_2.jpg", { room: "kitchen", prep: "tidy" });
    answers.set("IMG_3.jpg", { room: "primary bathroom", prep: "tidy", features: ["shower_in_background"] });
    const bellsBefore = await prisma.notification.count({ where: { kind: "photo_after_delivery" } });
    c.ok("the free check runs on the new listing photos", await runCheck(jobF.id));
    const jF = await prisma.photoJob.findUniqueOrThrow({ where: { id: jobF.id } });
    const fF = await findingsOf(jobF.id);
    c.ok("the cut-off roof on the new front photo is found", fF.some((f) => f.ruleId === "PERSP_AUTOHDR_ROOF_PEAKS_CROPPED" && f.status === "OPEN" && f.photoId === fresh[0].id));
    c.ok("the job stays delivered", jF.stage === "DELIVERED");
    const bell = await prisma.notification.findFirst({ where: { kind: "photo_after_delivery" }, orderBy: { createdAt: "desc" } });
    c.ok("Kyle and Jordan are told, like the other photo alerts", (await prisma.notification.count({ where: { kind: "photo_after_delivery" } })) > bellsBefore && /listing photos changed after delivery/.test(bell?.title ?? "") && /3 new or changed listing photos checked: 1 thing to look at/.test(bell?.body ?? ""), `${bell?.title} | ${bell?.body}`);
    const again8 = await check.driveAutohdrChecks({ budgetMs: 60_000, maxJobs: 5 });
    c.ok("checked once: nothing new, nothing asked again", !again8.jobs.some((j) => j.jobId === jobF.id));
    // A listing replaced BEFORE this was built: the photos are in the hub but never matched.
    const projH = await prisma.project.create({ data: { title: "12 Before Deploy Rd, Reading, PA", addressLine: "12 Before Deploy Rd", clientId: client.id, aryeoListingId: "lst-before" } });
    const shootH = fake.seedShoot({ address: "12 Before Deploy Rd", photos: [{ name: "H_1.jpg" }, { name: "H_2.jpg" }] });
    const jobH = await prisma.photoJob.create({ data: { projectId: projH.id, stage: "READY", autohdrPhotoshootId: shootH.photoshoot_id, autohdrCreatedAt: new Date() } });
    listings.set("lst-before", { delivered: true, images: [1, 2].map((n) => ({ id: `h-${n}`, filename: `Before (${n} of 2).jpg`, original_url: `https://cdn.aryeo.com/listings/before/${n}.jpg`, index: n - 1 })) });
    await prisma.photoJob.update({ where: { id: jobH.id }, data: { stage: "DELIVERED", stageChangedAt: new Date(Date.now() - 3_600_000) } });
    await jobs.syncJobFinals(jobH.id, new Date());
    await prisma.photoAsset.updateMany({ where: { jobId: jobH.id }, data: { autohdrImageUuid: null, autohdrVersionUuid: null } });
    await jobs.syncJobFinals(jobH.id, new Date());
    c.ok("a delivered job's photos never matched (replaced before this existed) are matched on its next pass", (await prisma.photoAsset.count({ where: { jobId: jobH.id, status: "ACTIVE", autohdrImageUuid: { not: null } } })) === 2);

    c.head("isolation");
    S.__setPhotoBytesLoaderForTests(null);
    c.ok("no paid AutoHDR call: no transform outside the planned fixes, no download", downloads() === 0 && fake.state.balance === 200);
    c.ok("no outbound call escaped the fakes", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
