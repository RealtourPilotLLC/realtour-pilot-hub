// ---------------------------------------------------------------------------
// DRILL: THE AUTOHDR FIX RUNNER AGAINST THE DOCUMENTED CONTRACT (Oct 14 2026).
// Jordan: "Persist job IDs and original/result version IDs; handle errors and
// retries safely … Implement with mocks first and require explicit approval
// before any paid API test." Everything here runs against _fake-autohdr.ts
// (built only from AutoHDR's published spec); no request leaves the machine.
// The fixture catalogue mirrors the Oct 14 free live read (autoremove 1 with a
// mask, reedit 1, no camera_removal) so the fallbacks are exercised.
//   · the owner's switch: OFF → a batch cannot be approved, nothing is sent
//   · strategy resolution: camera reflection → autoremove (no camera_removal)
//   · a fix: mapping proven by hash before any spend, mask at AutoHDR's exact
//     size uploaded as kind=mask, job id + input + output versions persisted,
//     ledger −1, result stored privately, findings FIXED, batch DONE, Kyle told
//   · a lost response: ONE POST, found again by listing, charged once
//   · no-op and failure: refunded in the ledger, findings re-opened
//   · a wrong mapping or an unpaid photo: stopped before any spend
//   · 402: nothing charged, job ON HOLD for credits, operation kept queued
// ---------------------------------------------------------------------------
import sharp from "sharp";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { createFakeAutohdr, type FakeTransform } from "./_fake-autohdr";

installNextStubs();

const TRANSFORMS: FakeTransform[] = [
  { name: "autoremove", credit_cost: 1, requires_mask: true, category: "object_removal" },
  { name: "autofill", credit_cost: 1, requires_mask: true, category: "inpaint" },
  { name: "reedit", credit_cost: 1, category: "ai_edit" },
  { name: "declutter", credit_cost: 1, category: "cleanup" },
  { name: "grass", credit_cost: 1, category: "lawn" },
  { name: "repaint", credit_cost: 0, category: "walls" },
  { name: "twilight", credit_cost: 5, category: "sky" },
  { name: "style", credit_cost: null, category: "style" },
];

const W = 1200, H = 800;
async function picture(kind: "kitchen" | "bath" | "other"): Promise<Buffer> {
  // Distinct, structured images so the perceptual hash means something.
  const svg =
    kind === "kitchen"
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#ddd"/><rect x="0" y="0" width="600" height="800" fill="#333"/><rect x="700" y="100" width="300" height="500" fill="#888"/></svg>`
      : kind === "bath"
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#222"/><rect x="600" y="0" width="600" height="400" fill="#eee"/><circle cx="300" cy="600" r="150" fill="#999"/></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#777"/><rect x="0" y="400" width="1200" height="400" fill="#111"/><rect x="200" y="50" width="100" height="300" fill="#fff"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5997) });
  const c = makeChecker();
  const kitchen = await picture("kitchen");
  const bath = await picture("bath");
  const other = await picture("other");
  // Which bytes AutoHDR serves for a version: by the photo's name.
  const bytesByPhotoName: Record<string, Buffer> = {};
  const fake: ReturnType<typeof createFakeAutohdr> = createFakeAutohdr({
    transforms: TRANSFORMS,
    models: [{ id: 1, name: "Classic", type: "predefined", variant: "indoor", style_credit_cost: 1 }],
    balance: 20,
    clientId: "cid",
    clientSecret: "drill-secret-1234567890",
    imageBytes: (ver) => {
      const p = fake.photoOfVersion(ver);
      return p ? new Uint8Array(bytesByPhotoName[p.name] ?? other) : null;
    },
  });
  const blobs: string[] = [];
  const fence = fenceFetch((url, init) => fake.handle(url, init));
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const fixes = await import("@/lib/photoDelivery/fixes");
    const runner = await import("@/lib/photoDelivery/fixRunner");
    await saveSecret("autohdr", "drill-secret-1234567890", { accountLabel: "drill", metadata: { clientId: "cid" } });

    // Source photos (the Aryeo copies the hub inspected) and the blob store.
    const sourceByUrl: Record<string, Buffer> = {};
    runner.__setFixRunnerHooksForTests({
      source: async (p) => sourceByUrl[p.sourceUrl ?? ""] ?? other,
      put: async (pathname) => {
        blobs.push(pathname);
        return { pathname, url: `blob://${pathname}` };
      },
    });

    // ---- seed ----------------------------------------------------------------------------
    const now = new Date();
    const owner = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "owner-fix@example.test", slackId: "UOWNER" } });
    await prisma.appUser.create({ data: { email: "owner-fix@example.test", role: "OWNER", status: "ACTIVE", teamMemberId: owner.id } });
    const client = await prisma.client.create({ data: { name: "Drill Fix Client TEST" } });
    const project = await prisma.project.create({ data: { title: "12 Test Ln, Testville, PA", addressLine: "12 Test Ln", clientId: client.id, shootDate: new Date(now.getTime() - 3_600_000), aryeoListingId: "lst-fix" } });
    const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "QC_REVIEW" } });
    const shoot = fake.seedShoot({ address: "12 Test Ln (Drill Fix Client TEST)", photos: [{ name: "DSC001.jpg" }, { name: "DSC002.jpg" }, { name: "DSC003.jpg", downloaded: false }], createdAt: new Date(now.getTime() - 3_600_000) });
    bytesByPhotoName["DSC001.jpg"] = kitchen;
    bytesByPhotoName["DSC002.jpg"] = bath;
    bytesByPhotoName["DSC003.jpg"] = other;
    const photo = async (n: number, bytes: Buffer) => {
      const url = `https://cdn.aryeo.com/drill/12 Test Ln (${n} of 3).jpg`;
      sourceByUrl[url] = bytes;
      return prisma.photoAsset.create({ data: { jobId: job.id, name: `12 Test Ln (${n} of 3).jpg`, sequence: n - 1, sourceKind: "ARYEO", sourceUrl: url, sourceRef: `img-${n}`, contentHash: `h${n}`, width: W, height: H, status: "ACTIVE" } });
    };
    const p1 = await photo(1, kitchen);
    const p2 = await photo(2, bath);
    const p3 = await photo(3, other);
    const run = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "INITIAL", status: "DONE", rulesVersion: "v1-2026-10-13" } });
    const finding = (photoId: string, ruleId: string, strategy: string, extra: Record<string, unknown> = {}) =>
      prisma.photoQcFinding.create({
        data: { qcRunId: run.id, jobId: job.id, photoId, ruleId, groupKey: ruleId.toLowerCase(), pass: "P1_PHOTO", source: "P1", specificIssue: ruleId, explanation: "drill", severity: "MAJOR", confidence: 0.9, responsibility: "PHOTOGRAPHER", fixStrategy: strategy, postFixable: true, ...extra },
      });
    const fTrash = await finding(p1.id, "PREP_TRASH_CANS", "AUTOREMOVE_MASK", { bboxJson: JSON.stringify([100, 100, 300, 400]) });
    const fCamera = await finding(p1.id, "REFL_CAMERA_TRIPOD_IN_MIRROR", "CAMERA_REMOVAL", { bboxJson: JSON.stringify([700, 150, 800, 300]) });
    const fToilet = await finding(p2.id, "BATH_TOILET_SEAT_OPEN", "REEDIT_PROMPT", { reeditPrompt: "Lower the raised toilet seat and lid. Change nothing else in the photo." });
    const fUnpaid = await finding(p3.id, "PREP_TRASH_CANS", "AUTOREMOVE_MASK", { bboxJson: JSON.stringify([10, 10, 50, 50]) });

    // ---- the owner's switch is OFF by default ---------------------------------------------
    let cart = await fixes.buildFixCart(job.id);
    c.ok("switch off: the cart says fixes are off until Jordan approves a live test", cart.blockers.some((b) => /switched off/.test(b)));
    const refused = await fixes.approveFixBatch({ jobId: job.id, findingIds: [fTrash.id], mode: "SELECTED", by: "drill-owner", role: "OWNER" });
    c.ok("switch off: a batch cannot be approved", !refused.ok);
    c.ok("switch off: nothing reached AutoHDR's transforms endpoint", fake.posts("/v1/transforms").length === 0);

    await savePhotoDeliverySettings({ fixRunnerEnabled: true }, "drill-owner");
    await prisma.photoJob.update({ where: { id: job.id }, data: { autohdrPhotoshootId: shoot.photoshoot_id, autohdrCreatedAt: new Date(shoot.created_at) } });
    const { linkAutohdrShoot } = await import("@/lib/photoDelivery/autohdrLink");
    const link = await linkAutohdrShoot(job.id);
    c.ok("the hub's photos are matched to AutoHDR by (N of M) with equal counts", link.linked && link.photos === 3);

    cart = await fixes.buildFixCart(job.id);
    const camLine = cart.lines.find((l) => l.findingIds.includes(fCamera.id));
    c.ok("live catalogue has no camera_removal: the reflection falls back to autoremove", camLine?.strategy === "AUTOREMOVE_MASK" && camLine.transform === "autoremove");
    c.ok("prices come from the live catalogue (autoremove 1, reedit 1)", cart.lines.find((l) => l.findingIds.includes(fToilet.id))?.credits === 1 && camLine?.credits === 1);

    const approved = await fixes.approveFixBatch({ jobId: job.id, findingIds: [fTrash.id, fCamera.id, fToilet.id], mode: "SELECTED", by: "drill-owner", role: "OWNER" });
    c.ok("approved: one batch, the two removals on photo 1 merged into ONE autoremove", approved.ok && approved.operations === 2);
    c.ok("approval moved the job to FIXING", (await prisma.photoJob.findUnique({ where: { id: job.id } }))?.stage === "FIXING");

    // ---- a lost response on the first submission --------------------------------------------
    fake.script("POST /v1/transforms", "lose-response");
    let r = await runner.driveFixes({ budgetMs: 30_000, leaseBy: "drill" });
    const ops = await prisma.photoFixOperation.findMany({ where: { jobId: job.id }, orderBy: { seq: "asc" } });
    const lost = ops.find((o) => o.status === "SUBMITTING");
    c.ok("a POST whose response was lost leaves the row SUBMITTING (not resent)", !!lost && fake.posts("/v1/transforms").length >= 1);
    const postsAfterLoss = fake.posts("/v1/transforms").length;
    r = await runner.driveFixes({ budgetMs: 30_000, leaseBy: "drill" });
    c.ok("within 2 minutes nothing is resent", fake.posts("/v1/transforms").length === postsAfterLoss);
    await prisma.photoFixOperation.update({ where: { id: lost!.id }, data: { submittedAt: new Date(Date.now() - 3 * 60_000) } });
    r = await runner.driveFixes({ budgetMs: 30_000, leaseBy: "drill" });
    const found = await prisma.photoFixOperation.findUnique({ where: { id: lost!.id } });
    c.ok("after 2 minutes the job is FOUND by listing (state=all), not resent", !!found?.autohdrJobId && found.status !== "SUBMITTING" && fake.posts("/v1/transforms").filter((p) => (p.body as { image_uuid?: string }).image_uuid === shoot.photos.find((x) => x.name === (lost!.photoId === p1.id ? "DSC001.jpg" : "DSC002.jpg"))!.image_uuid).length === 1);
    c.ok("the input (head) version id was persisted before the call", !!found?.inputVersionUuid);

    // Poll to completion.
    for (let i = 0; i < 8; i++) await runner.driveFixes({ budgetMs: 30_000, leaseBy: "drill" });
    const done = await prisma.photoFixOperation.findMany({ where: { jobId: job.id }, orderBy: { seq: "asc" } });
    c.ok("both operations succeeded", done.every((o) => o.status === "SUCCEEDED"), done.map((o) => `${o.transformName}:${o.status}:${o.error ?? ""}`).join(" | "));
    c.ok("each persisted job id + input + output version ids", done.every((o) => o.autohdrJobId && o.inputVersionUuid && o.outputVersionUuid && o.outputVersionUuid !== o.inputVersionUuid));
    const mask = fake.state.calls.find((x) => x.method === "POST" && x.path.endsWith("/asset-uploads"));
    c.ok("the mask was requested as kind=mask (AutoHDR defaults to reference)", (mask?.body as { kind?: string })?.kind === "mask");
    c.ok("the mask PNG was PUT with Content-Type image/png", fake.state.puts.some((p) => p.contentType === "image/png" && p.bytes > 0));
    const sub = fake.posts("/v1/transforms").map((p) => p.body as Record<string, unknown>);
    c.ok("the reedit carried the finding's prompt ending in the house suffix", sub.some((b) => b.transform_name === "reedit" && String(b.prompt).endsWith("Change nothing else in the photo.")));
    c.ok("autoremove carried the s3:// mask url", sub.some((b) => b.transform_name === "autoremove" && String(b.mask_url).startsWith("s3://")));
    const versions = await prisma.photoVersion.findMany({ where: { source: "FIX" } });
    c.ok("a FIX version row per result, parent = the input version", versions.length === 2 && versions.every((v) => v.autohdrVersionUuid && v.parentVersionUuid));
    c.ok("results stored in the private store", blobs.length === 2 && blobs.every((b) => b.startsWith(`photo-fixes/${job.id}/`)));
    const fx = await prisma.photoQcFinding.findMany({ where: { id: { in: [fTrash.id, fCamera.id, fToilet.id] } } });
    c.ok("the three findings are FIXED with the Aryeo replacement note", fx.every((f) => f.status === "FIXED" && /Aryeo/.test(f.statusReason ?? "")));
    const ledger = await prisma.autohdrCreditEntry.findMany({ where: { kind: { in: ["TRANSFORM", "REFUND", "DOWNLOAD"] } } });
    c.ok("ledger: exactly two charges of 1 credit, no download charge", ledger.filter((l) => l.kind === "TRANSFORM").length === 2 && ledger.every((l) => l.kind !== "DOWNLOAD") && ledger.filter((l) => l.kind === "TRANSFORM").every((l) => l.credits === -1));
    c.ok("the fake's balance agrees: 20 - 2 = 18", fake.state.balance === 18);
    const batch = await prisma.photoFixBatch.findFirst({ where: { jobId: job.id } });
    c.ok("batch DONE and the job back to READY (nothing MAJOR left open on these photos)", batch?.status === "DONE" && ["READY", "QC_REVIEW"].includes((await prisma.photoJob.findUnique({ where: { id: job.id } }))!.stage));
    c.ok("one 'fixes done' bell (owner only on this roster)", (await prisma.notification.count({ where: { kind: "photo_fixes_done" } })) >= 1);

    // ---- an unpaid photo: stopped before any spend --------------------------------------------
    await prisma.photoJob.update({ where: { id: job.id }, data: { stage: "QC_REVIEW" } });
    const before = fake.posts("/v1/transforms").length;
    const a2 = await fixes.approveFixBatch({ jobId: job.id, findingIds: [fUnpaid.id], mode: "SELECTED", by: "drill-owner", role: "OWNER" });
    await runner.driveFixes({ budgetMs: 30_000, leaseBy: "drill" });
    const unpaidOp = await prisma.photoFixOperation.findFirst({ where: { batchId: (a2 as { batchId: string }).batchId } });
    c.ok("a photo AutoHDR has not been paid for is ESCALATED, nothing posted", unpaidOp?.status === "ESCALATED" && /first download/.test(unpaidOp.error ?? "") && fake.posts("/v1/transforms").length === before);
    c.ok("…and no download was attempted for it", !fake.state.calls.some((x) => x.path.endsWith("/photos/download") && JSON.stringify(x.body).includes(shoot.photos[2].image_uuid)));

    // ---- a wrong mapping: stopped by the hash check -----------------------------------------------
    await prisma.photoJob.update({ where: { id: job.id }, data: { stage: "QC_REVIEW" } });
    const fWrong = await finding(p2.id, "PREP_TRASH_CANS", "AUTOREMOVE_MASK", { bboxJson: JSON.stringify([10, 10, 60, 60]) });
    sourceByUrl[p2.sourceUrl!] = other; // the hub's photo 2 no longer looks like AutoHDR's photo 2
    const a3 = await fixes.approveFixBatch({ jobId: job.id, findingIds: [fWrong.id], mode: "SELECTED", by: "drill-owner", role: "OWNER" });
    const beforeWrong = fake.posts("/v1/transforms").length;
    await runner.driveFixes({ budgetMs: 30_000, leaseBy: "drill" });
    const wrongOp = await prisma.photoFixOperation.findFirst({ where: { batchId: (a3 as { batchId: string }).batchId } });
    c.ok("a photo that does not match AutoHDR's is stopped before any spend", wrongOp?.status === "ESCALATED" && /does not look like it/.test(wrongOp.error ?? "") && fake.posts("/v1/transforms").length === beforeWrong);
    sourceByUrl[p2.sourceUrl!] = bath;

    // ---- a no-op and a failure: refunded --------------------------------------------------------------
    await linkAutohdrShoot(job.id); // re-match photo 2 after the mismatch cleared it
    await prisma.photoJob.update({ where: { id: job.id }, data: { stage: "QC_REVIEW" } });
    const fNoop = await finding(p2.id, "PREP_TRASH_CANS", "AUTOREMOVE_MASK", { bboxJson: JSON.stringify([20, 20, 80, 80]) });
    fake.setNextOutcome("noop");
    const a4 = await fixes.approveFixBatch({ jobId: job.id, findingIds: [fNoop.id], mode: "SELECTED", by: "drill-owner", role: "OWNER" });
    for (let i = 0; i < 6; i++) await runner.driveFixes({ budgetMs: 30_000, leaseBy: "drill" });
    const noopOp = await prisma.photoFixOperation.findFirst({ where: { batchId: (a4 as { batchId: string }).batchId } });
    c.ok("a no-op is recorded NOOP, refunded in the ledger, the finding re-opened", noopOp?.status === "NOOP" && noopOp.refunded === true && (await prisma.photoQcFinding.findUnique({ where: { id: fNoop.id } }))?.status === "OPEN" && (await prisma.autohdrCreditEntry.count({ where: { kind: "REFUND", ref: noopOp!.autohdrJobId } })) === 1);

    // ---- 402: nothing charged, held for credits -------------------------------------------------------
    await prisma.photoJob.update({ where: { id: job.id }, data: { stage: "QC_REVIEW" } });
    const fBroke = await finding(p2.id, "PREP_TRASH_CANS", "AUTOREMOVE_MASK", { bboxJson: JSON.stringify([30, 30, 90, 90]) });
    const a5 = await fixes.approveFixBatch({ jobId: job.id, findingIds: [fBroke.id], mode: "SELECTED", by: "drill-owner", role: "OWNER" });
    fake.state.balance = 0;
    await runner.driveFixes({ budgetMs: 30_000, leaseBy: "drill" });
    const brokeOp = await prisma.photoFixOperation.findFirst({ where: { batchId: (a5 as { batchId: string }).batchId } });
    const heldJob = await prisma.photoJob.findUnique({ where: { id: job.id } });
    c.ok("out of credits: the operation stays QUEUED and the job is ON HOLD for credits", brokeOp?.status === "QUEUED" && heldJob?.stage === "ON_HOLD" && heldJob.holdReason === "CREDITS");
    c.ok("…and nothing was charged", fake.state.balance === 0);

    // ---- the switch turned off: in-flight still polled, nothing new sent --------------------------------
    await savePhotoDeliverySettings({ fixRunnerEnabled: false }, "drill-owner");
    fake.state.balance = 10;
    const beforeOff = fake.posts("/v1/transforms").length;
    const off = await runner.driveFixes({ budgetMs: 30_000, leaseBy: "drill" });
    c.ok("switch off: no new submission", fake.posts("/v1/transforms").length === beforeOff && /switched off/.test(String(off.skipped)));
    const back = await prisma.photoJob.findUnique({ where: { id: job.id } });
    c.ok("credits back: the hold for credits is released by itself, back to FIXING", back?.stage === "FIXING" && back.holdReason === null, `${back?.stage} ${back?.holdReason}`);

    // ---- backend audit #5: never holds a delivery; a hold with nothing left to run ends in review ----------
    await savePhotoDeliverySettings({ fixRunnerEnabled: true }, "drill-owner");
    fake.state.balance = 0;
    await prisma.photoJob.update({ where: { id: job.id }, data: { stage: "DELIVERING" } });
    await runner.driveFixes({ budgetMs: 30_000, leaseBy: "drill" });
    c.ok("out of credits on a job being delivered: never put on hold", (await prisma.photoJob.findUnique({ where: { id: job.id } }))?.stage === "DELIVERING");
    await prisma.photoFixOperation.updateMany({ where: { jobId: job.id, status: "QUEUED" }, data: { status: "CANCELLED" } });
    await prisma.photoJob.update({ where: { id: job.id }, data: { stage: "ON_HOLD", holdReason: "CREDITS", holdResumeStage: "FIXING" } });
    await runner.driveFixes({ budgetMs: 30_000, leaseBy: "drill" });
    const settled = await prisma.photoJob.findUnique({ where: { id: job.id } });
    c.ok("a hold for credits with nothing left to run ends in review, never back in FIXING", ["QC_REVIEW", "READY"].includes(settled?.stage ?? "") && settled?.holdReason === null, `${settled?.stage} ${settled?.holdReason}`);

    c.ok("no request left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
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
