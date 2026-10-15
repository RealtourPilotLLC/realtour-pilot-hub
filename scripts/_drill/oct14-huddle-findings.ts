// ---------------------------------------------------------------------------
// DRILL: the Oct 14 2026 huddle findings (AutoHDR + Ops Hub workflow report).
//
// Jordan: "Fix it all and don't stop till you're done. The biggest problems
// were edits changing property details, missing originals for comparison, and
// perspective correction that would not undo."
//
//   1. Versions: every version kept (a 2048 px copy + sharpness) before and
//      after a fix; the image route serves an EARLIER version; Restore makes
//      it current in AutoHDR and the hub (and the Aryeo folder's fingerprint);
//      the gallery sync no longer resets a fixed photo to its first edit;
//      "Load every version" copies each AutoHDR step and puts the current one
//      back; nothing else touches the photo meanwhile.
//   2. The house stays the house: a car hiding the steps is never removed
//      automatically; a fix that changes the house is put back (checked); a
//      put-back AutoHDR refuses leaves a CRITICAL finding that Skip all keeps.
//   3. Perspective: a change made in AutoHDR's editor is picked up (head sync)
//      and a Ready run reads it first.
//   4. Softening: a fix that loses a third of the sharpness is put back.
//   5/9. Every finding gets the plan's reason; excluded kinds stay excluded;
//      "not there" and "not worth fixing" teach different things; Skip all
//      and the hub's own calls never teach; trash cans are always wanted.
//   7. The budget: by hand, repeats and put-back fixes count; refunds do not.
//   10. Moving several photos together lands them where they were dropped.
//   12. Delivery checks: every check recorded, errors too; round robin with
//       backoff; Aryeo's delivered webhook checks at once.
//
// ISOLATION: PGlite via the shared harness; AutoHDR, Aryeo and the private
// store answered in-process.
// ---------------------------------------------------------------------------
import sharp from "sharp";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { createFakeAutohdr } from "./_fake-autohdr";

installNextStubs();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Real JPEGs, so sharpness is measured: a crisp noise pattern and a blurred copy.
let crisp: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
let soft: Uint8Array = crisp;
const softVersions = new Set<string>();
// Versions whose file is told apart from the others (a different picture), to prove each copy is of its own version.
const stamped = new Map<string, Uint8Array>();
// A count that differs once and not on the recount is noise, never a changed house.
const noisyOnce = new Set<string>();
const fake = createFakeAutohdr({
  transforms: [{ name: "reedit", credit_cost: 1 }],
  balance: 200,
  clientId: "cid",
  clientSecret: "drill-secret-1234567890",
  imageBytes: (ver) => (softVersions.has(ver) || /^soft-/.test(fakeRef?.photoOfVersion(ver)?.name ?? "") && (fakeRef?.photoOfVersion(ver)?.versions.findIndex((v) => v.uuid === ver) ?? 0) >= 2 ? soft : stamped.get(ver) ?? crisp),
});
const fakeRef: typeof fake | null = fake;

// AutoHDR "forgets" to switch versions when this is on (a put-back that does not take).
let ignoreSetVersion = false;
// Aryeo listings for the delivery checks: id → delivery status, or "error".
const listings = new Map<string, string>();
const aryeoReads: string[] = [];
const fence = fenceFetch(async (url, init) => {
  if (ignoreSetVersion && /\/photos\/[^/]+\/version$/.test(new URL(url).pathname) && (init?.method ?? "GET") === "POST") return json({ ok: true });
  const faked = await fake.handle(url, init);
  if (faked) return faked;
  if (url.startsWith("https://api.aryeo.com/v1/listings/")) {
    const id = new URL(url).pathname.split("/")[3];
    aryeoReads.push(id);
    const st = listings.get(id);
    if (!st) return json({ message: "not found" }, 404);
    if (st === "error") return json({ message: "nope" }, 403);
    return json({ data: { id, delivery_status: st, images: [{ id: "i1", display_in_gallery: true }, { id: "i2", display_in_gallery: true }], floor_plans: [] } });
  }
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: "D1", ts: "1" });
  return null;
});

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6993) });
  const c = makeChecker();
  try {
    // Two real photos (noise, and the same noise blurred).
    const W = 900, HT = 600;
    const raw = Buffer.alloc(W * HT * 3);
    let seed = 12345;
    for (let i = 0; i < raw.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; raw[i] = seed >> 23; }
    crisp = new Uint8Array(await sharp(raw, { raw: { width: W, height: HT, channels: 3 } }).jpeg({ quality: 92 }).toBuffer());
    soft = new Uint8Array(await sharp(Buffer.from(crisp)).blur(6).jpeg({ quality: 92 }).toBuffer());

    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const B = await import("@/lib/photoDelivery/blob");
    const V = await import("@/lib/photoDelivery/versions");
    const policy = await import("@/lib/photoDelivery/fixPolicy");
    const runner = await import("@/lib/photoDelivery/fixRunner");
    const decisions = await import("@/lib/photoDelivery/decisions");
    await saveSecret("autohdr", "drill-secret-1234567890", { accountLabel: "drill", metadata: { clientId: "cid" } });
    await saveSecret("aryeo", ["drill", "key", "not", "real"].join("-"));
    await savePhotoDeliverySettings({ enabled: true, freeCheck: true, autoFix: true, fixRunnerEnabled: true, qcShadow: true, fixTargetUsd: 5, fixMaxUsd: 10, showAutohdrPhotos: true }, "drill");
    const store = new Map<string, Buffer>();
    B.__setDerivativeStoreForTests({
      async put(pathname, data) { store.set(pathname, Buffer.from(data)); return { pathname, url: `https://drill-store.private.blob.vercel-storage.invalid/${pathname}` }; },
      async read(ref) { const b = store.get(ref.pathname); return b ? { stream: new Blob([new Uint8Array(b)]).stream(), size: b.length, contentType: "image/jpeg" } : null; },
    });

    let seq = 0;
    const mkJob = async (street: string, names: string[], opts: { clientName?: string; stage?: string } = {}) => {
      const client = await prisma.client.create({ data: { name: opts.clientName ?? "Drill Client" } });
      const project = await prisma.project.create({ data: { title: `${street}, Reading, PA`, addressLine: street, clientId: client.id } });
      const shoot = fake.seedShoot({ address: street, photos: names.map((name) => ({ name, downloaded: true })) });
      const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: opts.stage ?? "QC_REVIEW", autohdrPhotoshootId: shoot.photoshoot_id, autohdrCreatedAt: new Date() } });
      const qcRun = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", startedAt: new Date(Date.now() - 60_000), finishedAt: new Date() } });
      await prisma.photoJob.update({ where: { id: job.id }, data: { lastQcRunId: qcRun.id } });
      const photos = [];
      for (let i = 0; i < names.length; i++) {
        const ph = shoot.photos[i];
        const hash = V.hashOfVersion(ph.head);
        photos.push(await prisma.photoAsset.create({ data: { jobId: job.id, name: ph.name, sourceKind: "AUTOHDR", sourceRef: `${shoot.photoshoot_id}/${ph.image_uuid}`, autohdrImageUuid: ph.image_uuid, autohdrVersionUuid: ph.head, contentHash: hash, inspectedHash: hash, sequence: i + seq++, status: "ACTIVE" } }));
      }
      return { job, photos, shoot, client, project, qcRun };
    };
    const find = (j: { job: { id: string }; qcRun: { id: string } }, photoId: string, ruleId: string, where: string, conf = 0.9, extra: Record<string, unknown> = {}) =>
      prisma.photoQcFinding.create({ data: { qcRunId: j.qcRun.id, jobId: j.job.id, photoId, ruleId, groupKey: ruleId, pass: "P1_PHOTO", source: "AHDR", specificIssue: `${ruleId}: ${where}`, explanation: "x", locationText: where, severity: "MAJOR", confidence: conf, responsibility: "EDITOR", fixStrategy: "REEDIT_PROMPT", reeditPrompt: policy.instructionFor(ruleId, where), status: "OPEN", arbitration: "CONFIRMED", ...extra } });
    const drive = async (n = 5) => { for (let i = 0; i < n; i++) await runner.driveFixes({ budgetMs: 60_000, leaseBy: "drill" }); };

    // What the free checks answer. Steps hidden on "steps-*"; the house changes on "changes-*".
    fake.state.describe = (name, prompt, version) => {
      if (/Count these permanent features/.test(prompt)) {
        // The versions AutoHDR made at intake are "before"; a fix's output is "after".
        const p = fake.photoOfVersion(version);
        const after = (p?.versions.findIndex((v) => v.uuid === version) ?? 0) >= 2;
        if (name.startsWith("changes-") && after) return '{"steps": 2, "stoops": 1, "porches": 0, "railings": 1, "doors": 1, "garage_doors": 0}';
        if (name.startsWith("noisy-") && after && !noisyOnce.has(name)) { noisyOnce.add(name); return '{"steps": 2, "stoops": 1, "porches": 0, "railings": 1, "doors": 1, "garage_doors": 0}'; }
        return '{"steps": 1, "stoops": 1, "porches": 0, "railings": 1, "doors": 1, "garage_doors": 0}';
      }
      if (/about to be edited/.test(prompt)) {
        if (name.startsWith("steps-")) return '{"house": "a porch with 3 front steps and a railing", "covers": true, "covered": "the front steps"}';
        return '{"house": "front door, 2 windows, a walkway, no steps", "covers": false, "covered": ""}';
      }
      if (/was just edited/.test(prompt)) {
        return '{"fixed": true, "left": "", "damaged": false, "damage": ""}';
      }
      return "A house.";
    };

    // ======================================================================
    c.head("1 · every version kept, shown, restored");
    const A = await mkJob("1 Version Way", ["front-1.jpg", "kitchen-2.jpg"]);
    const p0 = A.photos[0];
    const first = await V.captureVersion(p0, { versionUuid: p0.autohdrVersionUuid!, label: "AutoHDR edit", source: "AUTOHDR_INITIAL", by: "drill" });
    const firstRow = await prisma.photoVersion.findUniqueOrThrow({ where: { id: first!.id } });
    const firstMeta = V.versionMeta(firstRow.derivJson);
    c.ok("a version is kept: a copy in the private store and its sharpness", !!firstMeta.preview && store.has(firstMeta.preview.pathname) && (first?.sharpness ?? 0) > 0, JSON.stringify(firstMeta));
    c.ok("…stored under the job and photo, never a public link", /^photo-versions\/[^/]+\/[^/]+\/[^/]+\.jpg$/.test(firstMeta.preview!.pathname));
    const again = await V.captureVersion(p0, { versionUuid: p0.autohdrVersionUuid!, label: "AutoHDR edit", source: "AUTOHDR_INITIAL", by: "drill" });
    c.ok("keeping it twice is one row", again?.id === first?.id && (await prisma.photoVersion.count({ where: { photoId: p0.id } })) === 1);

    // A car fix on the photo (the runner keeps before and after).
    const fCar = await find(A, p0.id, "EXT_PARKED_CARS_DRIVEWAY", "driveway");
    const planA = await policy.planAutoFix(A.job.id);
    c.ok("the car is planned automatically", planA.planned && planA.photos === 1, JSON.stringify(planA));
    await drive();
    const opA = await prisma.photoFixOperation.findFirstOrThrow({ where: { jobId: A.job.id } });
    const submitted = fake.posts("/v1/transforms").map((p) => p.body as { prompt?: string });
    c.ok("the instruction says never to add or reshape the house", submitted.some((b) => (b.prompt ?? "").includes(policy.STRUCTURE_CLAUSE)), submitted.map((b) => b.prompt).join(" | "));
    c.ok("fixed and checked", opA.status === "VERIFIED", `${opA.status} ${opA.error ?? ""}`);
    const vers = await prisma.photoVersion.findMany({ where: { photoId: p0.id }, orderBy: { createdAt: "asc" } });
    const after = vers.find((v) => v.autohdrVersionUuid === opA.outputVersionUuid);
    c.ok("before and after are both kept with copies", vers.length === 2 && vers.every((v) => !!V.versionMeta(v.derivJson).preview) && !!after, vers.map((v) => `${v.label}:${v.source}`).join(", "));
    const pA1 = await prisma.photoAsset.findUniqueOrThrow({ where: { id: p0.id } });
    c.ok("the photo IS the fixed version: version, hash (the image's cache key)", pA1.autohdrVersionUuid === opA.outputVersionUuid && pA1.contentHash === V.hashOfVersion(opA.outputVersionUuid!));
    c.ok("…and stays inspected (delivery is not held for a re-check of its own fix)", pA1.inspectedHash === pA1.contentHash);
    c.ok("…its findings follow it", (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: fCar.id } })).contentHash !== "x");

    // The image route serves the EARLIER version (it used to ignore ?version).
    const route = await import("@/app/api/photo-delivery/img/[photoId]/[size]/route");
    const { NextRequest } = await import("next/server");
    const before = vers.find((v) => v.autohdrVersionUuid === firstRow.autohdrVersionUuid)!;
    const res = await route.GET(new NextRequest(`http://drill.local/api/photo-delivery/img/${p0.id}/thumb256?version=${before.id}`), { params: Promise.resolve({ photoId: p0.id, size: "thumb256" }) });
    const body = Buffer.from(await res.arrayBuffer());
    const meta = res.status === 200 ? await sharp(body).metadata() : null;
    c.ok("?version= serves the earlier version's own copy, resized", res.status === 200 && (meta?.width ?? 0) <= 256 && (meta?.width ?? 0) > 0 && /ver-/.test(res.headers.get("etag") ?? ""), `${res.status} ${res.headers.get("etag")} ${meta?.width}`);
    const bare = await prisma.photoVersion.create({ data: { photoId: p0.id, label: "old", source: "EDITOR", autohdrVersionUuid: "ver-not-kept" } });
    const res404 = await route.GET(new NextRequest(`http://drill.local/api/photo-delivery/img/${p0.id}/qc1024?version=${bare.id}`), { params: Promise.resolve({ photoId: p0.id, size: "qc1024" }) });
    c.ok("a version with no copy says so (and how to get it), never the current image", res404.status === 404 && /Load every version/.test(((await res404.json()) as { error: string }).error));
    await prisma.photoVersion.delete({ where: { id: bare.id } });

    // The lightbox data: current by version, kept, sharpness.
    const data = await import("@/app/ops/photo-delivery/data");
    const viewer = { role: "OWNER", name: "Jordan", isOwner: true, canSeeMoney: true };
    const detail = await data.loadJobDetail(A.job.id, { viewer });
    const view = detail!.photos.find((p) => p.id === p0.id)!;
    c.ok("the strip marks the fixed version current, both kept, with sharpness", view.versions.length === 2 && view.versions.filter((v) => v.current).length === 1 && view.versions.find((v) => v.current)?.id === after!.id && view.versions.every((v) => v.kept && v.sharpness != null), JSON.stringify(view.versions.map((v) => [v.label, v.current, v.kept, v.sharpness])));

    // Restore the version before the fix.
    const { readyFingerprintFor } = await import("@/lib/photoDelivery/handoff");
    const fp1 = await readyFingerprintFor(A.job.id);
    const r1 = await V.restoreVersion(p0.id, before.id, "Kyle");
    const live1 = (await (await import("@/lib/integrations/autohdr")).autohdr.listPhotos(A.shoot.photoshoot_id)).find((x) => x.image_uuid === p0.autohdrImageUuid)!;
    const pA2 = await prisma.photoAsset.findUniqueOrThrow({ where: { id: p0.id } });
    c.ok("Restore makes it current in AutoHDR (checked) and in the hub", r1.ok && live1.image_version_uuid === before.autohdrVersionUuid && pA2.autohdrVersionUuid === before.autohdrVersionUuid && pA2.contentHash === V.hashOfVersion(before.autohdrVersionUuid!), r1.message);
    c.ok("…so the Aryeo folder's fingerprint changes (the folder is refilled with it)", fp1 !== (await readyFingerprintFor(A.job.id)));
    c.ok("…and it says where it goes", /06-Ready-for-Aryeo/.test(r1.message), r1.message);
    c.ok("restoring the current one is a no-op", (await V.restoreVersion(p0.id, before.id, "Kyle")).message === "That is already the current version.");

    // The gallery sync must not put a fixed or restored photo back to its first edit.
    const J = await import("@/lib/photoDelivery/jobs");
    const S = await mkJob("2 Sync St", ["s-1.jpg"]);
    await prisma.photoAsset.deleteMany({ where: { jobId: S.job.id } });
    const sp = S.shoot.photos[0];
    await prisma.photoIntakeBatch.create({ data: { projectId: S.project.id, batchNo: 1, state: "DONE", rawPath: "/raw", filesJson: "[]", fileCount: 1, fingerprint: "fp-drill", photoshootId: S.shoot.photoshoot_id, photosJson: JSON.stringify([{ image_uuid: sp.image_uuid, image_version_uuid: sp.head, name: sp.name, url: null, downloaded: true }]) } });
    await J.syncJobFinals(S.job.id);
    const sRow = await prisma.photoAsset.findFirstOrThrow({ where: { jobId: S.job.id } });
    c.ok("the sync makes the photo from the shoot", sRow.autohdrVersionUuid === sp.head && sRow.contentHash === V.hashOfVersion(sp.head));
    await V.adoptVersion(sRow.id, "ver-fixed-later", "AUTOHDR");
    // Another photo arrives: the gallery changes and is read again.
    const sp2 = fake.seedShoot({ address: "x", photos: [{ name: "s-2.jpg" }] }).photos[0];
    await prisma.photoIntakeBatch.updateMany({ where: { projectId: S.project.id }, data: { photosJson: JSON.stringify([{ image_uuid: sp.image_uuid, image_version_uuid: sp.head, name: sp.name, url: null, downloaded: true }, { image_uuid: sp2.image_uuid, image_version_uuid: sp2.head, name: sp2.name, url: null, downloaded: true }]) } });
    const sync2 = await J.syncJobFinals(S.job.id);
    const sRow2 = await prisma.photoAsset.findUniqueOrThrow({ where: { id: sRow.id } });
    c.ok("a later sync keeps the fixed version (it used to reset it to the first edit)", sync2.changed && sRow2.autohdrVersionUuid === "ver-fixed-later" && sRow2.contentHash === V.hashOfVersion("ver-fixed-later"), `${sRow2.autohdrVersionUuid}`);

    // ======================================================================
    c.head("3 · a change made in AutoHDR's editor reaches the hub");
    const fakePhoto = fake.photoOfVersion(pA2.autohdrVersionUuid!)!;
    fakePhoto.versions.push({ uuid: "ver-persp-off", parent: pA2.autohdrVersionUuid!, label: "Perspective Off", description: null });
    fakePhoto.head = "ver-persp-off";
    const sync = await V.syncHeads(A.job.id, { by: "Kyle" });
    const pA3 = await prisma.photoAsset.findUniqueOrThrow({ where: { id: p0.id } });
    c.ok("Check AutoHDR for changes: the Perspective Off version is adopted", sync.changed.length === 1 && sync.changed[0].label === "Perspective Off" && pA3.autohdrVersionUuid === "ver-persp-off", JSON.stringify(sync));
    c.ok("…kept as a version with its copy", !!V.versionMeta((await prisma.photoVersion.findFirstOrThrow({ where: { photoId: p0.id, autohdrVersionUuid: "ver-persp-off" } })).derivJson).preview);
    c.ok("…and logged for the job", (await prisma.photoJobEvent.count({ where: { jobId: A.job.id, action: { contains: "Perspective Off" } } })) === 1);
    c.ok("nothing changed: nothing adopted", (await V.syncHeads(A.job.id)).changed.length === 0);
    fakePhoto.versions.push({ uuid: "ver-tilt", parent: "ver-persp-off", label: "Crop & Tilt", description: null });
    fakePhoto.head = "ver-tilt";
    await prisma.appSetting.deleteMany({ where: { key: `photo_ready_run:${A.job.id}` } });
    await (await import("@/lib/photoDelivery/handoff")).requestReady(A.job.id, { by: "Kyle" }).catch(() => null);
    c.ok("Get them ready again reads AutoHDR first (the folder gets the editor's version)", (await prisma.photoAsset.findUniqueOrThrow({ where: { id: p0.id } })).autohdrVersionUuid === "ver-tilt");

    // ======================================================================
    c.head("1b · every AutoHDR step loaded, the current one put back");
    await prisma.photoVersion.deleteMany({ where: { photoId: A.photos[1].id } });
    const p1 = A.photos[1];
    const fp = fake.photoOfVersion(p1.autohdrVersionUuid!)!;
    const headBefore = fp.head;
    // Each step has its own picture: the copy kept under a step's name must be that step's.
    const pictures = new Map<string, number>();
    for (const [i, v] of fp.versions.entries()) {
      const img = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 40 + i * 90, g: 20, b: 200 - i * 90 } } }).jpeg().toBuffer();
      stamped.set(v.uuid, new Uint8Array(img));
      pictures.set(v.uuid, 40 + i * 90);
    }
    const blocked = await V.loadVersionTimeline(p1.id, "Kyle");
    c.ok("never while the Aryeo folder is being filled (the head is switched while a step is copied)", !blocked.ok && /06-Ready-for-Aryeo right now/.test(blocked.message) && fp.head === headBefore, blocked.message);
    await prisma.appSetting.deleteMany({ where: { key: `photo_ready_run:${A.job.id}` } });
    const tl = await V.loadVersionTimeline(p1.id, "Kyle");
    const kept = await prisma.photoVersion.findMany({ where: { photoId: p1.id } });
    c.ok("each step (Original, Enhanced) kept with a copy", tl.ok && tl.loaded === 2 && kept.length === 2 && kept.every((v) => !!V.versionMeta(v.derivJson).preview), tl.message);
    c.ok("…the Original labelled as the capture", kept.some((v) => v.source === "ORIGINAL_FETCH" && v.label === "Original"));
    const reds = await Promise.all(kept.map(async (v) => {
      const b = store.get(V.versionMeta(v.derivJson).preview!.pathname)!;
      const { data } = await sharp(b).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
      return { v: v.autohdrVersionUuid!, red: data[0] };
    }));
    c.ok("…each copy is of its own version (the current one switched back to before it is copied)", reds.every((r) => Math.abs(r.red - pictures.get(r.v)!) < 20), JSON.stringify(reds.map((r) => [r.red, pictures.get(r.v)])));
    c.ok("the current version is put back in AutoHDR afterwards", fp.head === headBefore);
    c.ok("…and the guard is released", !(await V.versionProbeActive(A.job.id)));
    c.ok("loading again: nothing to copy", (await V.loadVersionTimeline(p1.id, "Kyle")).message === "Every version is already here.");
    // While a photo's history is copied, nothing else reads or edits that shoot.
    await prisma.appSetting.create({ data: { key: `photo_version_probe:${A.job.id}`, value: JSON.stringify({ photoId: p1.id, until: Date.now() + 60_000 }), updatedBy: "drill" } });
    fakePhoto.versions.push({ uuid: "ver-mid-probe", parent: "ver-tilt", label: "Temporary", description: null });
    fakePhoto.head = "ver-mid-probe";
    c.ok("the head sync waits while a history is being copied", (await V.syncHeads(A.job.id)).changed.length === 0 && (await prisma.photoAsset.findUniqueOrThrow({ where: { id: p0.id } })).autohdrVersionUuid === "ver-tilt");
    await find(A, p1.id, "REFL_SENSOR_DUST", "sky");
    await prisma.photoJob.update({ where: { id: A.job.id }, data: { stage: "QC_REVIEW" } });
    const pl = await prisma.photoFixBatch.create({ data: { jobId: A.job.id, mode: "SELECTED", estimatedCredits: 1, approvedBy: "Kyle", status: "PENDING" } });
    const probeOp = await prisma.photoFixOperation.create({ data: { batchId: pl.id, jobId: A.job.id, photoId: p1.id, findingIdsJson: JSON.stringify([(await prisma.photoQcFinding.findFirstOrThrow({ where: { photoId: p1.id } })).id]), seq: 0, strategy: "REEDIT_PROMPT", transformName: "reedit", estimatedCredits: 1, status: "QUEUED" } });
    await drive(1);
    c.ok("…and the fix runner waits too (no edit of a switched photo)", (await prisma.photoFixOperation.findUniqueOrThrow({ where: { id: probeOp.id } })).status === "QUEUED");
    await prisma.appSetting.deleteMany({ where: { key: `photo_version_probe:${A.job.id}` } });
    await prisma.photoFixOperation.update({ where: { id: probeOp.id }, data: { status: "CANCELLED" } });
    fakePhoto.head = "ver-tilt";

    // ======================================================================
    c.head("2 · the house stays the house");
    const H = await mkJob("3 Steps Ln", ["steps-1.jpg", "changes-2.jpg", "changes-3.jpg", "noisy-4.jpg"], { clientName: "Nehemiah Drill" });
    const fSteps = await find(H, H.photos[0].id, "EXT_VEHICLES_BLOCKING_HOME", "in front of the porch");
    const fChange = await find(H, H.photos[1].id, "EXT_PARKED_CARS_DRIVEWAY", "driveway");
    const fStuck = await find(H, H.photos[2].id, "EXT_PARKED_CARS_DRIVEWAY", "street");
    await find(H, H.photos[3].id, "EXT_PARKED_CARS_DRIVEWAY", "street");
    const balance0 = fake.state.balance;
    await policy.planAutoFix(H.job.id);
    // The third photo: AutoHDR will not take the put-back.
    let polls = 0;
    const origDescribe = fake.state.describe;
    fake.state.describe = (name, prompt, version) => {
      const isAfter = (fake.photoOfVersion(version)?.versions.findIndex((v) => v.uuid === version) ?? 0) >= 2;
      if (/Count these permanent features/.test(prompt) && name === "changes-3.jpg" && isAfter) ignoreSetVersion = true;
      if (name !== "changes-3.jpg" && /Count these permanent features/.test(prompt) && isAfter) ignoreSetVersion = false;
      polls++;
      return origDescribe!(name, prompt, version);
    };
    await drive(6);
    ignoreSetVersion = false;
    fake.state.describe = origDescribe;
    const ops = await prisma.photoFixOperation.findMany({ where: { jobId: H.job.id } });
    const opOf = (i: number) => ops.find((o) => o.photoId === H.photos[i].id)!;
    const steps = await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: fSteps.id } });
    c.ok("a car hiding the steps is never removed automatically: nothing sent, nothing spent", opOf(0).status === "ESCALATED" && !fake.posts("/v1/transforms").some((p) => (p.body as { image_uuid: string }).image_uuid === H.shoot.photos[0].image_uuid), `${opOf(0).status} ${opOf(0).error}`);
    c.ok("…the finding says why, in plain words, and stays open for a person", steps.status === "OPEN" && /hides part of the house \(the front steps\)/.test(steps.statusReason ?? "") && /left as it is/.test(steps.statusReason ?? ""), steps.statusReason ?? "");
    c.ok("a fix that changed the house is put back, checked, REVERTED", opOf(1).status === "REVERTED" && fake.photoOfVersion(opOf(1).inputVersionUuid!)!.head === opOf(1).inputVersionUuid, opOf(1).status);
    c.ok("…the finding says what changed, counted on both versions", /changed the house \(steps 1 → 2\)/.test((await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: fChange.id } })).statusReason ?? ""), (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: fChange.id } })).statusReason ?? "");
    c.ok("a count that differs once but not on the recount is noise: the fix stands", opOf(3).status === "VERIFIED", opOf(3).status);
    c.ok("…the features were counted before the fix and kept with it", (JSON.parse(opOf(1).verificationJson ?? "{}") as { before?: { counts?: { steps?: number } } }).before?.counts?.steps === 1);
    c.ok("…the check after compared against the house as it was", (JSON.parse(opOf(1).verificationJson ?? "{}") as { before?: { house?: string } }).before?.house === "front door, 2 windows, a walkway, no steps");
    c.ok("…the photo stays on the version before the fix", (await prisma.photoAsset.findUniqueOrThrow({ where: { id: H.photos[1].id } })).autohdrVersionUuid === opOf(1).inputVersionUuid);
    const damage = await prisma.photoQcFinding.findFirst({ where: { jobId: H.job.id, ruleId: "FIX_DAMAGE_AI_EDIT" } });
    c.ok("a put-back AutoHDR did not take is never reported as done: a CRITICAL finding holds the photo", opOf(2).status === "SUCCEEDED" && /did not take the previous version back/.test(opOf(2).error ?? "") && damage?.severity === "CRITICAL" && damage.photoId === H.photos[2].id && damage.status === "OPEN", `${opOf(2).status} ${opOf(2).error}`);
    c.ok("…and the photo is honest about what it is now (the changed version)", (await prisma.photoAsset.findUniqueOrThrow({ where: { id: H.photos[2].id } })).autohdrVersionUuid === opOf(2).outputVersionUuid);
    c.ok("only the three fixes that ran were charged (not the hidden-steps one)", balance0 - fake.state.balance === 3 && polls > 0, String(balance0 - fake.state.balance));
    const skip = await decisions.skipAllFindings(H.job.id, "Kyle");
    c.ok("Skip all never approves damage from an earlier fix", (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: damage!.id } })).status === "OPEN" && /stays open/.test(skip.message), skip.message);
    c.ok("…the delivery checklist still has it open", !(await (await import("@/lib/photoDelivery/delivery")).deliveryGate(H.job.id)).checks.find((x) => x.key === "critical")!.ok);
    void fStuck;

    // ======================================================================
    c.head("4 · a fix that softens the photo is put back");
    const Sf = await mkJob("4 Soft Ct", ["soft-1.jpg"]);
    await find(Sf, Sf.photos[0].id, "REFL_SENSOR_DUST", "sky");
    await policy.planAutoFix(Sf.job.id);
    await drive(5);
    const opS = await prisma.photoFixOperation.findFirstOrThrow({ where: { jobId: Sf.job.id } });
    const ver = JSON.parse(opS.verificationJson ?? "{}") as { sharpness?: { before: number; after: number }; note?: string };
    c.ok("sharpness measured at one size, before and after", (ver.sharpness?.before ?? 0) > 0 && (ver.sharpness?.after ?? 0) > 0 && ver.sharpness!.after < ver.sharpness!.before * 0.65, JSON.stringify(ver.sharpness));
    c.ok("…the softer fix is put back with why", opS.status === "REVERTED" && /noticeably softer/.test(ver.note ?? ""), `${opS.status} ${ver.note}`);
    const sDetail = await data.loadJobDetail(Sf.job.id, { viewer });
    c.ok("…and the strip shows which version is softer", sDetail!.photos[0].versions.some((v) => v.sharpness != null && !v.current && v.sharpness < Math.max(...sDetail!.photos[0].versions.map((x) => x.sharpness ?? 0)) * 0.65));

    // ======================================================================
    c.head("5 · every finding says why it was or was not fixed");
    const P = await mkJob("5 Plan Pl", ["p-1.jpg", "p-2.jpg", "p-3.jpg", "p-4.jpg", "p-5.jpg", "p-6.jpg"]);
    const notes = {
      privacy: await find(P, P.photos[0].id, "PREP_PERSONAL_DOCUMENTS", "fridge", 0.9, { privacySensitive: true }),
      verticals: await find(P, P.photos[1].id, "PERSP_CROOKED_VERTICALS", "left wall"),
      other: await find(P, P.photos[2].id, "OTHER_DEFECT", "a stain"),
      unsure: await find(P, P.photos[3].id, "EXT_TRASH_CANS_PRIMARY", "curb", 0.4),
      trash: await find(P, P.photos[4].id, "EXT_TRASH_CANS_PRIMARY", "curb"),
      clutter: await find(P, P.photos[5].id, "BATH_TOILET_SEAT_OPEN", "toilet"),
    };
    const planP = await policy.planAutoFix(P.job.id);
    const n = async (f: { id: string }) => (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: f.id } })).planNote ?? "";
    c.ok("privacy: never automatic, and why", /^Never automatic: privacy/.test(await n(notes.privacy)));
    c.ok("crooked verticals: free in AutoHDR, what to press", /^Free in AutoHDR.*Crop & Tilt/.test(await n(notes.verticals)));
    c.ok("an unnamed defect: a person decides", /^Never automatic/.test(await n(notes.other)));
    c.ok("an unsure finding: not fixed, with how sure", /only 40% sure/.test(await n(notes.unsure)));
    c.ok("trash cans: fixing, always", /^Fixing automatically: a trash can, always fixed/.test(await n(notes.trash)));
    c.ok("clutter in a prepared home: fixing inside the budget", /^Fixing automatically: clutter in a prepared home/.test(await n(notes.clutter)));
    const plannedIds = new Set((await prisma.photoFixOperation.findMany({ where: { jobId: P.job.id } })).flatMap((o) => JSON.parse(o.findingIdsJson) as string[]));
    c.ok("excluded kinds stay excluded: privacy, verticals, unnamed, unsure never in a fix", planP.planned && ![notes.privacy, notes.verticals, notes.other, notes.unsure].some((f) => plannedIds.has(f.id)) && plannedIds.has(notes.trash.id));
    c.ok("no dollar amounts in any reason (Kyle reads them)", !(await prisma.photoQcFinding.findMany({ where: { jobId: P.job.id } })).some((f) => /\$/.test(f.planNote ?? "")));
    // An as-is home: clutter skipped with why; trash still fixed.
    const Q = await mkJob("6 As Is Ave", ["q-1.jpg", "q-2.jpg", "q-3.jpg"], { clientName: "Nehemiah As-Is" });
    await savePhotoDeliverySettings({ asIsClientIds: [Q.client.id] }, "drill");
    const qClutter = await find(Q, Q.photos[0].id, "BED_UNMADE", "bed");
    const qTrash = await find(Q, Q.photos[1].id, "PREP_TRASH_CANS", "corner");
    await policy.planAutoFix(Q.job.id);
    c.ok("as-is: clutter skipped, and the reason names the rule", /^Skipped: as-is home \(the client is on the as-is list\)/.test(await n(qClutter)) && /Fixing automatically/.test(await n(qTrash)));
    await savePhotoDeliverySettings({ asIsClientIds: [] }, "drill");
    const summary = policy.fixPolicySummary({ fixTargetUsd: 5, fixMaxUsd: 10, asIsClientIds: [] });
    c.ok("the settings page states the same policy (always, as-is, free in AutoHDR, never, the checks)", summary.length === 5 && summary.some((g) => g.lines.some((l) => /hides part of the house/.test(l))) && summary.some((g) => g.lines.some((l) => /Skip all never touches it/.test(l))));

    // ======================================================================
    c.head("9 · not there vs not worth fixing, and what the hub learns");
    const L = await mkJob("7 Learn Ln", ["l-1.jpg"]);
    const mk = (ruleId: string, status: string, by: string, reason: string | null = null) => prisma.photoQcFinding.create({ data: { qcRunId: L.qcRun.id, jobId: L.job.id, photoId: L.photos[0].id, ruleId, groupKey: ruleId, pass: "P1_PHOTO", source: "AHDR", specificIssue: "x", explanation: "x", severity: "MINOR", confidence: 0.9, responsibility: "EDITOR", fixStrategy: "REEDIT_PROMPT", status, decidedBy: by, decidedAt: new Date(), statusReason: reason } });
    for (let i = 0; i < 3; i++) await mk("KIT_PAPER_TOWEL_ROLLS", "IGNORED", "Kyle");
    for (let i = 0; i < 5; i++) await mk("BATH_TOILET_SEAT_OPEN", "IGNORED", "Kyle", "Skipped all findings on this shoot");
    for (let i = 0; i < 3; i++) await mk("EXT_TRASH_CANS_PRIMARY", "IGNORED", "Kyle");
    for (let i = 0; i < 4; i++) await mk("EXT_PARKED_CARS_DRIVEWAY", "FALSE_POSITIVE", "Kyle");
    for (let i = 0; i < 6; i++) await mk("BED_UNMADE", "FALSE_POSITIVE", "free second look");
    await mk("EXT_PARKED_CARS_DRIVEWAY", "FIXED", "Kyle");
    const learned = await policy.learnedRules();
    c.ok("3 'not worth fixing' on a clutter check: no longer fixed on its own", learned.get("KIT_PAPER_TOWEL_ROLLS")?.skip === true);
    c.ok("Skip all is about one listing: it teaches nothing", !learned.has("BATH_TOILET_SEAT_OPEN"));
    c.ok("trash cans are always wanted, whatever one listing said", learned.get("EXT_TRASH_CANS_PRIMARY")?.skip === false);
    c.ok("'not there' 4 of 5 on cars: fixed on its own only when 80% sure", learned.get("EXT_PARKED_CARS_DRIVEWAY")?.strict === true && learned.get("EXT_PARKED_CARS_DRIVEWAY")?.skip === false);
    c.ok("the hub's own calls (the second look) teach nothing", !learned.has("BED_UNMADE"));
    const M = await mkJob("8 Learned Rd", ["m-1.jpg", "m-2.jpg", "m-3.jpg"]);
    const mTowel = await find(M, M.photos[0].id, "KIT_PAPER_TOWEL_ROLLS", "counter");
    const mCarUnsure = await find(M, M.photos[1].id, "EXT_PARKED_CARS_DRIVEWAY", "street", 0.7);
    const mCarSure = await find(M, M.photos[2].id, "EXT_PARKED_CARS_DRIVEWAY", "street", 0.85);
    await policy.planAutoFix(M.job.id);
    const mPlanned = new Set((await prisma.photoFixOperation.findMany({ where: { jobId: M.job.id } })).flatMap((o) => JSON.parse(o.findingIdsJson) as string[]));
    c.ok("the learned skip holds, with how many times and a way to override", !mPlanned.has(mTowel.id) && /"not worth fixing" 3 times in the last 60 days.*Press Fix/.test(await n(mTowel)), await n(mTowel));
    c.ok("a learned 'not there' needs 80%: 70% waits, 85% is fixed", !mPlanned.has(mCarUnsure.id) && mPlanned.has(mCarSure.id) && /80% sure/.test(await n(mCarUnsure)), await n(mCarUnsure));

    // ======================================================================
    c.head("7 · what counts toward the shoot's fix budget");
    const Bg = await mkJob("9 Budget Blvd", ["b-1.jpg", "b-2.jpg"]);
    const auto = await prisma.photoFixBatch.create({ data: { jobId: Bg.job.id, mode: "AUTO", estimatedCredits: 2, approvedBy: "auto-fix", status: "DONE" } });
    const hand = await prisma.photoFixBatch.create({ data: { jobId: Bg.job.id, mode: "SELECTED", estimatedCredits: 2, approvedBy: "Kyle", status: "DONE" } });
    const op = (batchId: string, photoId: string, status: string, charged: number | null, refunded = false) => prisma.photoFixOperation.create({ data: { batchId, jobId: Bg.job.id, photoId, findingIdsJson: "[]", seq: 0, strategy: "REEDIT_PROMPT", transformName: "reedit", estimatedCredits: 1, chargedCredits: charged, refunded, status } });
    await op(auto.id, Bg.photos[0].id, "VERIFIED", 1);
    await op(auto.id, Bg.photos[1].id, "REVERTED", 1);
    await op(hand.id, Bg.photos[0].id, "VERIFIED", 1);
    await op(hand.id, Bg.photos[1].id, "FAILED", 1, true);
    await op(hand.id, Bg.photos[1].id, "QUEUED", null);
    const b = await policy.fixBudgetFor(Bg.job.id);
    c.ok("spent 3 (2 automatic incl. one put back, 1 by hand), 1 waiting", b.spent === 3 && b.pending === 1 && b.automatic === 2 && b.byHand === 2, JSON.stringify(b));
    c.ok("a put-back fix still counts; a refund does not; second edits of a photo count", b.reverted === 1 && b.refunded === 1 && b.repeats === 2, JSON.stringify(b));

    // ======================================================================
    c.head("10 · several photos moved together");
    const { moveTogether } = await import("@/components/photoDelivery/format");
    const ord = ["a", "b", "c", "d", "e", "f"];
    c.ok("ticked d and f dropped on b: they land before b, in their order", moveTogether(ord, ["f", "d"], 1).join("") === "adfbce");
    c.ok("ticked a and b dropped on e (downward): they land after e", moveTogether(ord, ["a", "b"], 4).join("") === "cdeabf");
    c.ok("dropped on one of themselves: nothing moves", moveTogether(ord, ["c", "d"], 3).join("") === "abcdef");

    // ======================================================================
    c.head("12 · delivery checks: recorded, fair, prompt");
    const sweep = await import("@/lib/photoDelivery/verifySweep");
    const del: { id: string; listing: string }[] = [];
    for (let i = 0; i < 10; i++) {
      const proj = await prisma.project.create({ data: { title: `${10 + i} Deliver Dr, Reading, PA`, aryeoListingId: `L${i}`, clientId: A.client.id } });
      const j = await prisma.photoJob.create({ data: { projectId: proj.id, stage: "DELIVERING", deliveryStartedAt: new Date(Date.now() - (10 - i) * 60_000) } });
      for (let k = 0; k < 2; k++) await prisma.photoAsset.create({ data: { jobId: j.id, name: `d${k}.jpg`, sourceKind: "DROPBOX", contentHash: `d${i}${k}`, sequence: k, status: "ACTIVE" } });
      listings.set(`L${i}`, i === 9 ? "error" : "SCHEDULED");
      del.push({ id: j.id, listing: `L${i}` });
    }
    const s1 = await sweep.verifyDeliveringJobs({ max: 8 });
    const s2 = await sweep.verifyDeliveringJobs({ max: 8 });
    const checkedIds = new Set((await prisma.photoJob.findMany({ where: { id: { in: del.map((d) => d.id) }, deliveryCheckedAt: { not: null } }, select: { id: true } })).map((x) => x.id));
    c.ok("round robin: the two left over from the first pass are checked on the next (none starved)", s1.checked === 8 && s2.checked === 2 && checkedIds.size === 10, `${JSON.stringify(s1)} ${JSON.stringify(s2)}`);
    c.ok("…a job checked a minute ago is not asked again yet", (await sweep.verifyDeliveringJobs({ max: 8 })).checked === 0);
    const errJob = await prisma.photoJob.findUniqueOrThrow({ where: { id: del[9].id } });
    c.ok("an error is recorded and counted as an error, not a mismatch", s2.errors + s1.errors === 1 && /Couldn't read the Aryeo listing/.test(errJob.deliveryCheckNote ?? "") && errJob.stage === "DELIVERING", errJob.deliveryCheckNote ?? "");
    const waitJob = await prisma.photoJob.findUniqueOrThrow({ where: { id: del[0].id } });
    c.ok("a wait is recorded in Aryeo's words", /Aryeo still has the listing as scheduled/.test(waitJob.deliveryCheckNote ?? ""), waitJob.deliveryCheckNote ?? "");
    c.ok("backoff: every pass for the first hour, every 15 minutes after, hourly after a day", sweep.checkEveryMs(30 * 60_000) === 4 * 60_000 && sweep.checkEveryMs(2 * 3_600_000) === 15 * 60_000 && sweep.checkEveryMs(30 * 3_600_000) === 3_600_000);
    // Aryeo's delivered webhook checks the job at once.
    listings.set("L3", "DELIVERED");
    await prisma.photoJob.update({ where: { id: del[3].id }, data: { deliveryCheckedAt: new Date(Date.now() - 60_000) } });
    const { handleAryeoActivity } = await import("@/lib/aryeoDelivery");
    const reads = aryeoReads.length;
    await handleAryeoActivity("LISTING_DELIVERED", { listing_id: "L3", resource: { id: "L3" } }, { authenticated: false });
    const delivered = await prisma.photoJob.findUniqueOrThrow({ where: { id: del[3].id } });
    c.ok("Aryeo says delivered → verified at once, not on the next pass", delivered.stage === "DELIVERED" && aryeoReads.length > reads && /Verified/.test(delivered.deliveryCheckNote ?? ""), `${delivered.stage} ${delivered.deliveryCheckNote}`);
    const dJob = await data.loadJobDetail(del[0].id, { viewer });
    c.ok("the job page shows the last check, what Aryeo said and the next check", !!dJob!.header.deliveryCheckedAt && /scheduled/.test(dJob!.header.deliveryCheckNote ?? "") && !!dJob!.header.deliveryNextCheckAt && Date.parse(dJob!.header.deliveryNextCheckAt!) > Date.now());
    // Right after Mark as delivering: Kyle had already delivered in Aryeo.
    const proj2 = await prisma.project.create({ data: { title: "30 Quick St, Reading, PA", aryeoListingId: "LQ", clientId: A.client.id } });
    const jq = await prisma.photoJob.create({ data: { projectId: proj2.id, stage: "DELIVERING", deliveryStartedAt: new Date() } });
    for (let k = 0; k < 2; k++) await prisma.photoAsset.create({ data: { jobId: jq.id, name: `q${k}.jpg`, sourceKind: "DROPBOX", contentHash: `q${k}`, sequence: k, status: "ACTIVE" } });
    listings.set("LQ", "DELIVERED");
    await sweep.verifySoonAfterStart(jq.id);
    c.ok("Mark as delivering checks straight away", (await prisma.photoJob.findUniqueOrThrow({ where: { id: jq.id } })).stage === "DELIVERED");

    c.head("isolation");
    c.ok("nothing left the fakes", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
