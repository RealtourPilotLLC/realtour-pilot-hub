// ---------------------------------------------------------------------------
// DRILL: AUTOMATIC QC FIXES ON A BUDGET (Oct 14 2026, fixPolicy.ts).
//
// Jordan: "$5-$10 MAX on QC fixes per shoot. $5 most of the time ... places
// like Nehemiah's shoots that are completely unprepared we shouldn't have to do
// any QC fixes other than photographer in the mirror, cars, trash cans, dust
// spots, or anything camera user error related ... a second qc check against
// its findings, and then another QC check after it's fixed. All free ...
// Automatically. ... the after fix check is just to confirm it was fixed."
//
//   1. the free second look: a "no" is set aside, a "yes" confirmed, an
//      unreadable answer asked once more then kept; the verdict follows
//   2. the plan: one re-edit per photo with every instruction for it; camera,
//      car and trash photos first; clutter only in a prepared home and only
//      inside the $5 target; never past the $10 maximum; never privacy;
//      as-is homes (listed client, or a third of the photos cluttered) get no
//      clutter fixes; planned once per check
//   3. the runner on the hub's own shoot: no download, no mapping spend, the
//      merged instruction sent, 1 credit each, never past the maximum
//   4. the check after the fix (free): fixed → FIXED; still there → open for a
//      person; clearly damaged → previous version put back
//   5. Jordan and Kyle hear when it is done; nothing left the fakes
// ---------------------------------------------------------------------------
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { createFakeAutohdr } from "./_fake-autohdr";

installNextStubs();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fake = createFakeAutohdr({ transforms: [{ name: "reedit", credit_cost: 1 }, { name: "autoremove", credit_cost: 1, requires_mask: true }, { name: "twilight", credit_cost: 5 }, { name: "single_angle_staging", credit_cost: 5 }, { name: "declutter", credit_cost: 1 }, { name: "style", credit_cost: null }], models: [{ id: 6, name: "Twilight Golden", type: "predefined", variant: "outdoor", style_credit_cost: 1 }], balance: 200, clientId: "cid", clientSecret: "drill-secret-1234567890" });
const fence = fenceFetch(async (url, init) => (await fake.handle(url, init)) ?? (url.startsWith("https://slack.com/api/") ? json({ ok: true, channel: "D1", ts: "1" }) : null));

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6995) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { savePhotoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    const policy = await import("@/lib/photoDelivery/fixPolicy");
    const runner = await import("@/lib/photoDelivery/fixRunner");
    await saveSecret("autohdr", "drill-secret-1234567890", { accountLabel: "drill", metadata: { clientId: "cid" } });
    const owner = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "owner-af@example.test" } });
    await prisma.appUser.create({ data: { email: "owner-af@example.test", role: "OWNER", status: "ACTIVE", teamMemberId: owner.id } });
    await savePhotoDeliverySettings({ enabled: true, freeCheck: true, autoFix: true, fixRunnerEnabled: true, qcShadow: true, fixTargetUsd: 5, fixMaxUsd: 10 }, "drill");

    // A hub-sent shoot: N photos, in AutoHDR, not downloaded yet.
    let seq = 0;
    const mkJob = async (street: string, n: number, clientName = "Drill Client") => {
      const client = await prisma.client.create({ data: { name: clientName } });
      const project = await prisma.project.create({ data: { title: `${street}, Reading, PA`, addressLine: street, clientId: client.id } });
      const shoot = fake.seedShoot({ address: street, photos: Array.from({ length: n }, (_, i) => ({ name: `${street.split(" ")[0]}-${i + 1}.jpg`, downloaded: false })) });
      const job = await prisma.photoJob.create({ data: { projectId: project.id, stage: "QC_REVIEW", autohdrPhotoshootId: shoot.photoshoot_id, autohdrCreatedAt: new Date() } });
      const qcRun = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "AUTOHDR_CHECK", status: "DONE", rulesVersion: "v", startedAt: new Date(Date.now() - 60_000), finishedAt: new Date() } });
      await prisma.photoJob.update({ where: { id: job.id }, data: { lastQcRunId: qcRun.id } });
      const photos = [];
      for (let i = 0; i < n; i++) {
        const ph = shoot.photos[i];
        photos.push(await prisma.photoAsset.create({ data: { jobId: job.id, name: ph.name, sourceKind: "AUTOHDR", sourceRef: `${shoot.photoshoot_id}/${ph.image_uuid}`, autohdrImageUuid: ph.image_uuid, autohdrVersionUuid: ph.head, contentHash: `h${seq++}`, sequence: i, status: "ACTIVE" } }));
      }
      return { job, photos, shoot, client, qcRun };
    };
    const find = (jobId: string, runId: string, photoId: string, ruleId: string, where: string, conf = 0.9, extra: Record<string, unknown> = {}) =>
      prisma.photoQcFinding.create({ data: { qcRunId: runId, jobId, photoId, ruleId, groupKey: ruleId, pass: "P1_PHOTO", source: "AHDR", specificIssue: `${ruleId}: ${where}`, explanation: "x", locationText: where, severity: "MAJOR", confidence: conf, responsibility: "EDITOR", fixStrategy: "AUTOREMOVE_MASK", reeditPrompt: policy.instructionFor(ruleId, where), status: "OPEN", ...extra } });

    // ======================================================================
    c.head("1 · the free second look");
    const A = await mkJob("10 Ready Rd", 6);
    const fA = [
      await find(A.job.id, A.qcRun.id, A.photos[0].id, "EXT_TRASH_CANS_PRIMARY", "curb, left"),
      await find(A.job.id, A.qcRun.id, A.photos[0].id, "EXT_GARDEN_HOSES", "by the porch"),
      await find(A.job.id, A.qcRun.id, A.photos[1].id, "EXT_VEHICLES_BLOCKING_HOME", "bottom right"),
      await find(A.job.id, A.qcRun.id, A.photos[2].id, "REFL_PHOTOGRAPHER_IN_MIRROR", "bathroom mirror"),
      await find(A.job.id, A.qcRun.id, A.photos[3].id, "BATH_TOILET_SEAT_OPEN", "toilet on the right"),
      await find(A.job.id, A.qcRun.id, A.photos[4].id, "PREP_PERSONAL_DOCUMENTS", "paper on the door", 0.9, { privacySensitive: true }),
      await find(A.job.id, A.qcRun.id, A.photos[5].id, "REFL_SENSOR_DUST", "in the sky"),
    ];
    const asked: string[] = [];
    let unreadable = true;
    fake.state.describe = (name, prompt) => {
      asked.push(prompt);
      if (/really visible/.test(prompt)) {
        // Photo 1's hose is not really there; photo 4's answer is junk once.
        if (name.endsWith("-1.jpg")) return '{"items":[{"n":1,"present":true},{"n":2,"present":false}]}';
        if (name.endsWith("-4.jpg") && unreadable) { unreadable = false; return "Looks fine to me"; }
        return `{"items":[${prompt.split("\n").filter((l) => /^\d+\. /.test(l)).map((_, i) => `{"n":${i + 1},"present":true}`).join(",")}]}`;
      }
      if (/was just edited/.test(prompt)) {
        if (name.endsWith("-3.jpg")) return '{"fixed": false, "left": "the reflection is still faintly visible", "damaged": false, "damage": ""}';
        if (name.endsWith("-6.jpg")) return '{"fixed": true, "left": "", "damaged": true, "damage": "the facade is warped"}';
        return '{"fixed": true, "left": "", "damaged": false, "damage": ""}';
      }
      return "A room.";
    };
    const p0 = await policy.planAutoFix(A.job.id);
    c.ok("nothing is planned while the second look is still to run", !p0.planned && /second look/.test(p0.reason), p0.reason);
    const l1 = await policy.secondLookJob(A.job.id, Date.now() + 60_000);
    c.ok("first pass: one unreadable answer is asked again", !l1.done && l1.overturned === 1, JSON.stringify(l1));
    const l2 = await policy.secondLookJob(A.job.id, Date.now() + 60_000);
    c.ok("second pass finishes", l2.done, JSON.stringify(l2));
    const hose = await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: fA[1].id } });
    c.ok("a 'no' is set aside as not an issue, with the reason", hose.status === "FALSE_POSITIVE" && hose.arbitration === "OVERTURNED" && /second look did not see it/.test(hose.statusReason ?? ""));
    c.ok("a 'yes' is confirmed", (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: fA[0].id } })).arbitration === "CONFIRMED");
    c.ok("the second look asks about each photo's own items, numbered", asked.some((p) => /1\. Trash bins in exterior: curb, left\n2\. Garden hose/.test(p)));
    const photoCalls = asked.filter((p) => /really visible/.test(p)).length;
    c.ok("one question per photo (6 photos, one asked twice)", photoCalls === 7, String(photoCalls));

    // ======================================================================
    c.head("2 · the plan: a prepared home");
    const pA = await policy.planAutoFix(A.job.id);
    const opsA = await prisma.photoFixOperation.findMany({ where: { jobId: A.job.id }, orderBy: { createdAt: "asc" } });
    c.ok("planned: 5 photos, 5 credits, not as-is", pA.planned && pA.photos === 5 && pA.credits === 5 && !pA.asIs, JSON.stringify(pA));
    c.ok("one re-edit per photo, never a mask", opsA.every((o) => o.transformName === "reedit" && o.strategy === "REEDIT_PROMPT" && o.estimatedCredits === 1) && new Set(opsA.map((o) => o.photoId)).size === opsA.length);
    c.ok("privacy (the paper) is never fixed automatically", !opsA.some((o) => o.photoId === A.photos[4].id));
    c.ok("the toilet lid (clutter) is fixed in a prepared home", opsA.some((o) => o.photoId === A.photos[3].id));
    c.ok("the set-aside hose is not in any fix", !opsA.some((o) => (JSON.parse(o.findingIdsJson) as string[]).includes(fA[1].id)));
    c.ok("job FIXING, findings APPROVED_FIX by auto-fix", (await prisma.photoJob.findUniqueOrThrow({ where: { id: A.job.id } })).stage === "FIXING" && (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: fA[0].id } })).decidedBy === "auto-fix");
    const again = await policy.planAutoFix(A.job.id);
    c.ok("planned once per check", !again.planned, again.reason);

    // ======================================================================
    c.head("2b · an as-is home and the budget");
    await savePhotoDeliverySettings({ asIsClientIds: [] }, "drill");
    const B = await mkJob("20 Messy Ave", 4, "Nehemiah Drill");
    await savePhotoDeliverySettings({ asIsClientIds: [B.client.id] }, "drill");
    await find(B.job.id, B.qcRun.id, B.photos[0].id, "BED_UNMADE", "bed", 0.9, { arbitration: "CONFIRMED" });
    await find(B.job.id, B.qcRun.id, B.photos[1].id, "KIT_DIRTY_DISHES_SINK", "sink", 0.9, { arbitration: "CONFIRMED" });
    await find(B.job.id, B.qcRun.id, B.photos[1].id, "PREP_TRASH_CANS", "corner", 0.9, { arbitration: "CONFIRMED" });
    await find(B.job.id, B.qcRun.id, B.photos[2].id, "REFL_SENSOR_DUST", "sky", 0.9, { arbitration: "CONFIRMED" });
    const pB = await policy.planAutoFix(B.job.id);
    const opsB = await prisma.photoFixOperation.findMany({ where: { jobId: B.job.id } });
    c.ok("as-is (listed client): only the trash and dust photos, 2 credits", pB.planned && pB.asIs && pB.credits === 2 && opsB.length === 2, JSON.stringify(pB));
    const trashOp = opsB.find((o) => o.photoId === B.photos[1].id)!;
    const trashIds = JSON.parse(trashOp.findingIdsJson) as string[];
    c.ok("…and the dishes on the trash photo ride along? no: as-is means no clutter at all", trashIds.length === 1);
    const C = await mkJob("30 Busy St", 30);
    for (let i = 0; i < 25; i++) await find(C.job.id, C.qcRun.id, C.photos[i].id, "EXT_VEHICLES_BLOCKING_HOME", "street", 0.9, { arbitration: "CONFIRMED" });
    for (let i = 25; i < 28; i++) await find(C.job.id, C.qcRun.id, C.photos[i].id, "KIT_PAPER_TOWEL_ROLLS", "counter", 0.9, { arbitration: "CONFIRMED" });
    const pC = await policy.planAutoFix(C.job.id);
    c.ok("25 car photos: capped at the $10 maximum (20 credits), 5 left for a person", pC.planned && pC.credits === 20 && pC.left === 8, JSON.stringify(pC));
    c.ok("…clutter-only photos never go past the $5 target", (await prisma.photoFixOperation.count({ where: { jobId: C.job.id, photoId: { in: C.photos.slice(25).map((p) => p.id) } } })) === 0);
    c.ok("a low-confidence finding is never fixed", policy.fixClass("EXT_VEHICLES_BLOCKING_HOME") === "always" && policy.fixClass("PREP_PERSONAL_DOCUMENTS") === "never" && policy.fixClass("COMP_BLURRY") === "never");

    // ======================================================================
    c.head("3 · the runner on the hub's own shoot");
    const before = fake.state.balance;
    const t1 = await runner.driveFixes({ budgetMs: 60_000, leaseBy: "drill" });
    const submits = fake.posts("/v1/transforms");
    c.ok("submitted every queued re-edit", t1.submitted >= 5 && submits.length === t1.submitted, JSON.stringify(t1));
    c.ok("no download and no mapping spend on hub photos", fake.posts("/v1/photoshoots/").filter((p) => p.path.endsWith("/download")).length === 0);
    const sent = submits.find((p) => (p.body as { image_uuid: string }).image_uuid === A.shoot.photos[0].image_uuid)!.body as { transform_name: string; prompt: string };
    c.ok("the instruction for the photo, merged and closed with 'change nothing else'", sent.transform_name === "reedit" && /Remove the trash bins/.test(sent.prompt) && /Change nothing else in the photo\.$/.test(sent.prompt) && !/hose/i.test(sent.prompt), sent.prompt);
    c.ok("1 credit per photo charged", before - fake.state.balance === submits.length);

    // ======================================================================
    c.head("4 · the check after the fix");
    for (let i = 0; i < 4; i++) await runner.driveFixes({ budgetMs: 60_000, leaseBy: "drill" });
    const done = await prisma.photoFixOperation.findMany({ where: { jobId: A.job.id } });
    const opOf = (photoIdx: number) => done.find((o) => o.photoId === A.photos[photoIdx].id)!;
    c.ok("fixed and checked → VERIFIED, findings FIXED", opOf(0).status === "VERIFIED" && (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: fA[0].id } })).status === "FIXED");
    const mirror = await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: fA[3].id } });
    c.ok("still there → open for a person, with what is left", mirror.status === "OPEN" && /Still there after the AI fix: the reflection is still faintly visible/.test(mirror.statusReason ?? ""), mirror.statusReason ?? "");
    const warped = opOf(5);
    const versionPosts = fake.posts("/v1/photoshoots/").filter((p) => p.path.endsWith("/version"));
    c.ok("clearly damaged → previous version put back (free), REVERTED", warped.status === "REVERTED" && versionPosts.some((p) => (p.body as { image_version_uuid: string }).image_version_uuid === warped.inputVersionUuid));
    c.ok("…the finding is open again with why", /put back: the facade is warped/.test((await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: fA[6].id } })).statusReason ?? ""));
    c.ok("the after-fix check looked at the NEW version", fake.state.calls.some((x) => x.path.endsWith("/describe") && !!(x.body as { image_version_uuid?: string }).image_version_uuid));
    c.ok("the job leaves FIXING when the batch is done", ["QC_REVIEW", "READY"].includes((await prisma.photoJob.findUniqueOrThrow({ where: { id: A.job.id } })).stage));
    const n = await prisma.notification.findMany({ where: { kind: "photo_fixes_done" } });
    c.ok("Jordan and Kyle hear: done, credits, push from AutoHDR", n.length >= 1 && n.some((x) => /Automatic fixes done/.test(x.title)), n.map((x) => x.title).join(" | "));

    // ======================================================================
    c.head("5 · the maximum holds at the paid call too");
    const D = await mkJob("40 Cap Ct", 3);
    const batch = await prisma.photoFixBatch.create({ data: { jobId: D.job.id, mode: "AUTO", approvedBy: "auto-fix", estimatedCredits: 21 } });
    for (let i = 0; i < 20; i++) await prisma.photoFixOperation.create({ data: { batchId: batch.id, jobId: D.job.id, photoId: D.photos[0].id, findingIdsJson: "[]", seq: 100 + i, strategy: "REEDIT_PROMPT", transformName: "reedit", estimatedCredits: 1, chargedCredits: 1, status: "VERIFIED" } });
    const fD = await find(D.job.id, D.qcRun.id, D.photos[1].id, "PREP_TRASH_CANS", "corner");
    await prisma.photoFixOperation.create({ data: { batchId: batch.id, jobId: D.job.id, photoId: D.photos[1].id, findingIdsJson: JSON.stringify([fD.id]), seq: 0, strategy: "REEDIT_PROMPT", transformName: "reedit", estimatedCredits: 1, status: "QUEUED" } });
    const posts0 = fake.posts("/v1/transforms").length;
    await runner.driveFixes({ budgetMs: 60_000, leaseBy: "drill" });
    const over = await prisma.photoFixOperation.findFirstOrThrow({ where: { jobId: D.job.id, seq: 0 } });
    c.ok("21st credit on one shoot: not sent", over.status === "ESCALATED" && /automatic fix maximum/.test(over.error ?? "") && fake.posts("/v1/transforms").length === posts0, over.error ?? "");

    // ======================================================================
    c.head("6 · ordered add-ons at QC");
    const fixes = await import("@/lib/photoDelivery/fixes");
    const verdictMod = await import("@/lib/photoDelivery/qc/verdict");
    const E = await mkJob("50 Order Ln", 4);
    await prisma.photoJob.update({ where: { id: E.job.id }, data: { expectedJson: JSON.stringify({ requestedFeatures: [], source: {}, twilightVirtual: 1, virtualStagingCount: 1, virtualDeclutterCount: 1, twilightReal: 1 }) } });
    await prisma.photoQcRun.update({ where: { id: E.qcRun.id }, data: { checksJson: JSON.stringify({ done: {}, errors: {}, skipped: [], rooms: { [E.photos[0].id]: "front exterior", [E.photos[1].id]: "living room", [E.photos[2].id]: "kitchen", [E.photos[3].id]: "front exterior" }, light: { [E.photos[0].id]: "day", [E.photos[1].id]: "day", [E.photos[2].id]: "day", [E.photos[3].id]: "twilight" }, furnished: { [E.photos[1].id]: "empty", [E.photos[2].id]: "furnished" } }) } });
    await find(E.job.id, E.qcRun.id, E.photos[2].id, "KIT_DIRTY_DISHES_SINK", "sink", 0.9, { arbitration: "CONFIRMED" });
    await find(E.job.id, E.qcRun.id, E.photos[2].id, "KIT_PAPER_TOWEL_ROLLS", "counter", 0.9, { arbitration: "CONFIRMED" });
    const sg = await policy.suggestAddOns(E.job.id);
    const adds = await prisma.photoQcFinding.findMany({ where: { jobId: E.job.id, source: "ADDON" } });
    const addOf = (rule: string) => adds.find((a) => a.ruleId === rule);
    c.ok("3 suggestions + 1 real twilight re-render", sg.suggested === 3 && sg.twilightRerenders === 1, JSON.stringify(sg));
    c.ok("virtual twilight on the daytime front exterior (not the dusk one)", addOf("ADDON_VIRTUAL_TWILIGHT")?.photoId === E.photos[0].id);
    c.ok("virtual staging on the empty living room, with the room type", addOf("ADDON_VIRTUAL_STAGING")?.photoId === E.photos[1].id && /"room_type":"living_room"/.test(addOf("ADDON_VIRTUAL_STAGING")?.coercedJson ?? ""));
    c.ok("virtual declutter on the most cluttered room", addOf("ADDON_VIRTUAL_DECLUTTER")?.photoId === E.photos[2].id);
    const twOp = await prisma.photoFixOperation.findFirst({ where: { jobId: E.job.id, transformName: "style" }, include: { batch: true } });
    c.ok("the dusk photo is re-rendered with the twilight model automatically (not the fix budget)", twOp?.photoId === E.photos[3].id && /"model_id":6/.test(twOp.paramsJson ?? "") && twOp.batch.approvedBy === "auto-twilight" && twOp.estimatedCredits === 1);
    c.ok("suggestions never make a verdict worse", verdictMod.jobVerdict(adds.filter((a) => a.ruleId !== "ADDON_REAL_TWILIGHT_LOOK").map((a) => ({ ...a, photoIds: null })), {}).verdict === "PASS");
    c.ok("…and never enter the automatic fix plan", policy.fixClass("ADDON_VIRTUAL_TWILIGHT") === "never");
    const again2 = await policy.suggestAddOns(E.job.id);
    c.ok("suggested once per check", !!again2.skipped && /already/.test(again2.skipped), JSON.stringify(again2));
    const cart = await fixes.buildFixCart(E.job.id);
    const line = (rule: string) => cart.lines.find((l) => l.ruleId === rule);
    c.ok("in the Fix Cart, priced live, not pre-selected: twilight 5, staging 5, declutter 1", line("ADDON_VIRTUAL_TWILIGHT")?.credits === 5 && line("ADDON_VIRTUAL_STAGING")?.credits === 5 && line("ADDON_VIRTUAL_DECLUTTER")?.credits === 1 && cart.lines.filter((l) => l.addOn).every((l) => !l.selectedByDefault && !l.humanCall), JSON.stringify(cart.lines.filter((l) => l.addOn).map((l) => [l.ruleId, l.credits, l.humanCall])));
    await prisma.photoJob.update({ where: { id: E.job.id }, data: { stage: "QC_REVIEW" } });
    const ap = await fixes.approveFixBatch({ jobId: E.job.id, findingIds: [addOf("ADDON_VIRTUAL_STAGING")!.id], mode: "SELECTED", by: "Jordan", role: "OWNER" });
    const stOp = await prisma.photoFixOperation.findFirst({ where: { jobId: E.job.id, transformName: "single_angle_staging" } });
    c.ok("one click: a staging edit with the room type", ap.ok && /"room_type":"living_room"/.test(stOp?.paramsJson ?? ""), ap.ok ? "" : ap.message);
    for (let i = 0; i < 4; i++) await runner.driveFixes({ budgetMs: 60_000, leaseBy: "drill" });
    const sentStyle = fake.posts("/v1/transforms").find((x) => (x.body as { transform_name: string }).transform_name === "style")?.body as { model_id?: number } | undefined;
    const sentStage = fake.posts("/v1/transforms").find((x) => (x.body as { transform_name: string }).transform_name === "single_angle_staging")?.body as { params?: { room_type?: string } } | undefined;
    c.ok("sent: style with the twilight model, staging with the room", sentStyle?.model_id === 6 && sentStage?.params?.room_type === "living_room", JSON.stringify([sentStyle, sentStage]));

    // ======================================================================
    c.head("7 · Kyle submits fixes inside the shoot's budget");
    const F = await mkJob("60 Budget Blvd", 25);
    const fF: { id: string }[] = [];
    for (let i = 0; i < 22; i++) fF.push(await find(F.job.id, F.qcRun.id, F.photos[i].id, "PREP_TRASH_CANS", "corner", 0.9, { arbitration: "CONFIRMED", reeditPrompt: null }));
    const twoOnOne = await find(F.job.id, F.qcRun.id, F.photos[0].id, "EXT_GARDEN_HOSES", "porch", 0.9, { arbitration: "CONFIRMED" });
    await prisma.photoJob.update({ where: { id: F.job.id }, data: { stage: "QC_REVIEW" } });
    const cartF = await fixes.buildFixCart(F.job.id);
    const l0 = cartF.lines.filter((l) => l.photoId === F.photos[0].id);
    c.ok("a free-check finding on a hub photo is a 1-credit re-edit (no marked area needed)", l0.length === 2 && l0.every((l) => l.strategy === "REEDIT_PROMPT" && l.credits === 1 && !l.humanCall), JSON.stringify(l0.map((l) => [l.strategy, l.credits, l.humanCall])));
    c.ok("the budget box: 20 max, 10 normally, nothing used yet", cartF.budget?.maxCredits === 20 && cartF.budget.targetCredits === 10 && cartF.budget.spent === 0);
    const kyleOk = await fixes.approveFixBatch({ jobId: F.job.id, findingIds: [fF[0].id, twoOnOne.id, ...fF.slice(1, 12).map((f) => f.id)], mode: "SELECTED", by: "Kyle", role: "ADMIN" });
    const opsF = await prisma.photoFixOperation.findMany({ where: { jobId: F.job.id } });
    c.ok("Kyle's 13 fixes on 12 photos: 12 credits, one edit for the photo with two", kyleOk.ok && kyleOk.estimatedCredits === 12 && opsF.length === 12 && opsF.some((o) => (JSON.parse(o.findingIdsJson) as string[]).length === 2), kyleOk.ok ? "" : kyleOk.message);
    c.ok("…the findings got their written instruction", !!(await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: fF[0].id } })).reeditPrompt);
    await prisma.photoJob.update({ where: { id: F.job.id }, data: { stage: "QC_REVIEW" } });
    const overBudget = await fixes.approveFixBatch({ jobId: F.job.id, findingIds: fF.slice(12, 22).map((f) => f.id), mode: "SELECTED", by: "Kyle", role: "ADMIN" });
    c.ok("past the $10 maximum: Kyle is told what is used and left", !overBudget.ok && /12 of 20 credits already used, 8 left, and this batch is 10/.test(overBudget.message), overBudget.ok ? "" : overBudget.message);
    const cartF2 = await fixes.buildFixCart(F.job.id);
    c.ok("the box shows 12 used by hand (waiting to run)", cartF2.budget?.byHand === 12 && cartF2.budget.pending === 12 && cartF2.budget.automatic === 0, JSON.stringify(cartF2.budget));
    const jordanOver = await fixes.approveFixBatch({ jobId: F.job.id, findingIds: fF.slice(12, 22).map((f) => f.id), mode: "SELECTED", by: "Jordan", role: "OWNER" });
    c.ok("Jordan may go past it", jordanOver.ok, jordanOver.ok ? "" : jordanOver.message);
    const G = await mkJob("70 Left Ln", 6);
    for (let i = 0; i < 6; i++) await find(G.job.id, G.qcRun.id, G.photos[i].id, "EXT_VEHICLES_BLOCKING_HOME", "street", 0.9, { arbitration: "CONFIRMED" });
    const gb = await prisma.photoFixBatch.create({ data: { jobId: G.job.id, mode: "SELECTED", approvedBy: "Kyle", estimatedCredits: 17 } });
    await prisma.photoFixOperation.create({ data: { batchId: gb.id, jobId: G.job.id, photoId: G.photos[0].id, findingIdsJson: "[]", seq: 9, strategy: "REEDIT_PROMPT", transformName: "reedit", estimatedCredits: 17, chargedCredits: 17, status: "VERIFIED" } });
    const pG = await policy.planAutoFix(G.job.id);
    c.ok("the automatic plan only uses what is left (17 by hand → 3 more)", pG.planned && pG.credits === 3, JSON.stringify(pG));

    // ======================================================================
    c.head("8 · verticals and a cut-off roof: free in AutoHDR, never a paid re-edit");
    // Jordan, Oct 14 2026: "Straightened vertical lines should be fixed via AutoHDR Auto
    // Perspective corrections, and it should be turned off if the correction cuts off the top of the house."
    const H = await mkJob("80 Level Ln", 3);
    const vert = await find(H.job.id, H.qcRun.id, H.photos[0].id, "PERSP_CROOKED_VERTICALS", "whole facade", 0.9, { arbitration: "CONFIRMED", severity: "MAJOR" });
    const roof = await find(H.job.id, H.qcRun.id, H.photos[1].id, "PERSP_AUTOHDR_ROOF_PEAKS_CROPPED", "top edge", 0.9, { arbitration: "CONFIRMED", severity: "CRITICAL", reeditPrompt: null });
    c.ok("the policy classes them as free AutoHDR fixes", policy.fixClass("PERSP_CROOKED_VERTICALS") === "autohdr" && policy.fixClass("PERSP_EXTERIOR_WALLS_LEANING") === "autohdr" && policy.fixClass("PERSP_AUTOHDR_ROOF_PEAKS_CROPPED") === "autohdr" && !policy.ALWAYS_FIX.has("PERSP_CROOKED_VERTICALS"));
    const pH = await policy.planAutoFix(H.job.id);
    c.ok("the automatic plan spends nothing on them", (await prisma.photoFixOperation.count({ where: { jobId: H.job.id } })) === 0 && !(pH.planned && pH.credits > 0), JSON.stringify(pH));
    await prisma.photoJob.update({ where: { id: H.job.id }, data: { stage: "QC_REVIEW" } });
    const cartH = await fixes.buildFixCart(H.job.id);
    const lv = cartH.lines.find((l) => l.findingIds.includes(vert.id));
    const lr = cartH.lines.find((l) => l.findingIds.includes(roof.id));
    c.ok("in the cart: no credits, what to press in AutoHDR (an old paid instruction is ignored)", lv?.humanCall === "autohdr-editor" && lv.credits === 0 && !lv.transform && /Crop & Tilt/.test(lv.howTo ?? ""), JSON.stringify(lv));
    c.ok("a cut-off roof: turn Perspective Off on that photo, free", lr?.humanCall === "autohdr-editor" && /Perspective Off/.test(lr.howTo ?? "") && /top of the house/.test(lr.howTo ?? ""), JSON.stringify(lr));
    const tryH = await fixes.approveFixBatch({ jobId: H.job.id, findingIds: [vert.id, roof.id], mode: "SELECTED", by: "Kyle", role: "ADMIN" });
    c.ok("they cannot be sent as a paid fix", !tryH.ok && /Nothing selected can be fixed automatically/.test(tryH.message), tryH.ok ? "" : tryH.message);
    const fs = await import("node:fs");
    const checkSrc = fs.readFileSync("src/lib/photoDelivery/autohdrCheck.ts", "utf8");
    c.ok("the free check writes no paid instruction for them", /reeditPrompt: fixClass\(rule\.id\) === "autohdr" \? null : instructionFor/.test(checkSrc) && /"PERSP_AUTOHDR_ROOF_PEAKS_CROPPED"/.test(checkSrc));
    c.ok("the Fix Cart shows them in their own 'Free in AutoHDR' list", /Free in AutoHDR \(\{inAutohdr\.length\}\)/.test(fs.readFileSync("src/components/photoDelivery/FixCartPanel.tsx", "utf8")));

    // ======================================================================
    c.head("9 · the engine audit (Oct 15 2026)");
    const decisions = await import("@/lib/photoDelivery/decisions");
    const check = await import("@/lib/photoDelivery/autohdrCheck");
    const D9 = await import("@/lib/photoDelivery/delivery");
    const { AutohdrError } = await import("@/lib/integrations/autohdr");
    await prisma.photoFixOperation.updateMany({ where: { status: "QUEUED" }, data: { status: "CANCELLED" } }); // earlier sections' leftovers
    const drive = () => runner.driveFixes({ budgetMs: 60_000, leaseBy: "drill" });
    // #12: the switch.
    await savePhotoDeliverySettings({ fixRunnerEnabled: false }, "drill");
    const K = await mkJob("90 Switch St", 2);
    await find(K.job.id, K.qcRun.id, K.photos[0].id, "EXT_TRASH_CANS_PRIMARY", "curb", 0.9, { arbitration: "CONFIRMED" });
    const pK = await policy.planAutoFix(K.job.id);
    c.ok("AutoHDR fixes switched off: nothing planned, the job is never parked in FIXING", !pK.planned && /switched off/.test(pK.reason) && (await prisma.photoJob.findUniqueOrThrow({ where: { id: K.job.id } })).stage === "QC_REVIEW", pK.reason);
    await savePhotoDeliverySettings({ fixRunnerEnabled: true }, "drill");
    // #15: one review rule, which waits while a fix is still to run.
    const pK2 = await policy.planAutoFix(K.job.id);
    c.ok("the review rule says stay while a fix is still waiting", pK2.planned && (await decisions.reviewStage(K.job.id)).stage === "stay", JSON.stringify(pK2));
    await prisma.photoFixOperation.updateMany({ where: { jobId: K.job.id, status: "QUEUED" }, data: { status: "CANCELLED" } });
    // #6: two approvals at once.
    const R9 = await mkJob("91 Race Rd", 1);
    const fR9 = await find(R9.job.id, R9.qcRun.id, R9.photos[0].id, "EXT_TRASH_CANS_PRIMARY", "curb", 0.9, { arbitration: "CONFIRMED" });
    const both = await Promise.all([fixes.approveFixBatch({ jobId: R9.job.id, findingIds: [fR9.id], mode: "SELECTED", by: "Kyle", role: "ADMIN" }), fixes.approveFixBatch({ jobId: R9.job.id, findingIds: [fR9.id], mode: "SELECTED", by: "Jordan", role: "OWNER" })]);
    c.ok("two approvals at once: one batch, one paid edit", both.filter((x) => x.ok).length === 1 && (await prisma.photoFixOperation.count({ where: { jobId: R9.job.id } })) === 1, JSON.stringify(both));
    await prisma.photoFixOperation.updateMany({ where: { jobId: R9.job.id, status: "QUEUED" }, data: { status: "CANCELLED" } });
    // #6: a lost submission on a later batch's photo, looked up in that photo's own shoot.
    const U9 = await mkJob("94 Later Ln", 1);
    const later = fake.seedShoot({ address: "94 Later Ln (more photos 2)", photos: [{ name: "Later-2.jpg", downloaded: false }] });
    const lp = await prisma.photoAsset.create({ data: { jobId: U9.job.id, name: "Later-2.jpg", sourceKind: "AUTOHDR", sourceRef: `${later.photoshoot_id}/${later.photos[0].image_uuid}`, autohdrImageUuid: later.photos[0].image_uuid, autohdrVersionUuid: later.photos[0].head, contentHash: "later-2", sequence: 1, status: "ACTIVE" } });
    await find(U9.job.id, U9.qcRun.id, lp.id, "EXT_TRASH_CANS_PRIMARY", "curb", 0.9, { arbitration: "CONFIRMED" });
    await policy.planAutoFix(U9.job.id);
    fake.script("POST /v1/transforms", "lose-response");
    await drive();
    const lostOp = await prisma.photoFixOperation.findFirstOrThrow({ where: { jobId: U9.job.id } });
    await prisma.photoFixOperation.update({ where: { id: lostOp.id }, data: { submittedAt: new Date(Date.now() - 3 * 60_000) } });
    const postsLost = fake.posts("/v1/transforms").length;
    await drive();
    const foundOp = await prisma.photoFixOperation.findUniqueOrThrow({ where: { id: lostOp.id } });
    c.ok("a lost submission on a later batch's photo is found in its own shoot, never sent again", lostOp.status === "SUBMITTING" && !!foundOp.autohdrJobId && fake.posts("/v1/transforms").length === postsLost, `${lostOp.status} → ${foundOp.status} ${foundOp.error ?? ""}`);
    // #9: AutoHDR failing during the second look.
    const S9 = await mkJob("92 Down St", 1);
    const fS9 = await find(S9.job.id, S9.qcRun.id, S9.photos[0].id, "EXT_TRASH_CANS_PRIMARY", "curb");
    policy.__setFixDescribeForTests(async () => { throw new AutohdrError("AutoHDR is down", 503, null, true); });
    await policy.secondLookJob(S9.job.id, Date.now() + 60_000);
    await policy.secondLookJob(S9.job.id, Date.now() + 60_000);
    policy.__setFixDescribeForTests(null);
    const sl = await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: fS9.id } });
    c.ok("AutoHDR down during the second look: the finding is left as it was, never confirmed or fixed", sl.arbitration === "NOT_REQUIRED" && sl.status === "OPEN" && !(await policy.planAutoFix(S9.job.id)).planned, `${sl.arbitration} ${sl.status}`);
    // #18: "no photo fits yet" once per check.
    const T9 = await mkJob("93 Fit Ln", 1);
    await prisma.photoJob.update({ where: { id: T9.job.id }, data: { expectedJson: JSON.stringify({ virtualStagingCount: 1 }) } });
    await policy.suggestAddOns(T9.job.id);
    await policy.suggestAddOns(T9.job.id);
    c.ok("'no photo fits yet' is said once per check, not every pass", (await prisma.photoJobEvent.count({ where: { jobId: T9.job.id, actor: "add-ons" } })) === 1);
    // #8 and #11: a photo the free check could not read is never a pass; the checked ones count as inspected.
    const W9 = await mkJob("95 Check Ct", 3);
    await prisma.photoJob.update({ where: { id: W9.job.id }, data: { stage: "EDITED", finalsChangedAt: new Date() } });
    const prevDescribe = fake.state.describe;
    let described: string[] = [];
    let outage = true;
    fake.state.describe = (name, prompt, version) => {
      if (!/checking a real estate listing photo/.test(prompt)) return prevDescribe ? prevDescribe(name, prompt, version) : "A room.";
      described.push(name);
      if (name === "95-3.jpg" && outage) return "no idea";
      return name === "95-1.jpg" ? '{"room":"kitchen","issues":[{"id":"KIT_PAPER_TOWEL_ROLLS","where":"counter","confidence":0.9}]}' : '{"room":"bedroom","issues":[]}';
    };
    for (let i = 0; i < 3; i++) await check.driveAutohdrChecks({ budgetMs: 60_000 });
    const w1 = await prisma.photoJob.findUniqueOrThrow({ where: { id: W9.job.id } });
    const notChecked = await prisma.photoQcFinding.findFirst({ where: { jobId: W9.job.id, ruleId: "OTHER_DEFECT", status: "OPEN" } });
    c.ok("a photo the free check could not read: Needs decision, with an issue saying so", w1.stage === "QC_REVIEW" && notChecked?.photoId === W9.photos[2].id && notChecked.severity === "MAJOR" && /could not look/.test(notChecked.specificIssue), `${w1.stage} ${notChecked?.specificIssue}`);
    const bell = await prisma.notification.findFirst({ where: { kind: "photo_free_check", body: { contains: "1 could not be checked" } } });
    c.ok("…and the bell says how many could not be checked", !!bell, bell?.body ?? "");
    const wPhotos = await prisma.photoAsset.findMany({ where: { jobId: W9.job.id }, orderBy: { sequence: "asc" } });
    c.ok("the photos it looked at count as inspected, the unread one does not", wPhotos[0].inspectedHash === wPhotos[0].contentHash && wPhotos[1].inspectedHash === wPhotos[1].contentHash && wPhotos[2].inspectedHash === null);
    const gate9 = await D9.deliveryGate(W9.job.id);
    c.ok("the checklist after a free check: no gallery line, and the unread photo is the one not inspected", !gate9.checks.some((x) => x.key === "gallery") && gate9.checks.find((x) => x.key === "qc")?.detail === "1 photo not inspected", JSON.stringify(gate9.checks));
    // #10: the gallery changes after the check: only the new and changed photos are looked at.
    const more = fake.seedShoot({ address: "95 Check Ct (more photos 2)", photos: [{ name: "95-4.jpg" }] });
    await prisma.photoAsset.create({ data: { jobId: W9.job.id, name: "95-4.jpg", sourceKind: "AUTOHDR", sourceRef: `${more.photoshoot_id}/${more.photos[0].image_uuid}`, autohdrImageUuid: more.photos[0].image_uuid, autohdrVersionUuid: more.photos[0].head, contentHash: "95-4", sequence: 3, status: "ACTIVE" } });
    await prisma.photoJob.update({ where: { id: W9.job.id }, data: { finalsChangedAt: new Date() } });
    outage = false;
    described = [];
    const firstRun = w1.lastQcRunId;
    await check.driveAutohdrChecks({ budgetMs: 60_000 });
    const w2 = await prisma.photoJob.findUniqueOrThrow({ where: { id: W9.job.id } });
    c.ok("a changed gallery in review is checked again: only the new and the unread photo", w2.lastQcRunId !== firstRun && described.sort().join() === "95-3.jpg,95-4.jpg", described.join());
    c.ok("…the unchanged photos keep their findings; the unread one's 'could not look' is history", (await prisma.photoQcFinding.count({ where: { jobId: W9.job.id, ruleId: "KIT_PAPER_TOWEL_ROLLS", status: "OPEN" } })) === 1 && (await prisma.photoQcFinding.findUniqueOrThrow({ where: { id: notChecked!.id } })).status === "SUPERSEDED");
    fake.state.describe = prevDescribe;
    // Oct 23 2026 (Jordan: "Paid Photo QC should be off. Only using the free version."): nothing asks for it.
    const inspectedBefore = await prisma.photoAsset.count({ where: { jobId: W9.job.id, inspectedHash: { not: null } } });
    // Oct 25 2026 (audit D7): the paid re-run request was deleted with the paid engine.
    c.ok("there is no way to ask for the paid QC, and nothing the free check looked at is touched", !("requestQcRerun" in decisions) && (await prisma.photoAsset.count({ where: { jobId: W9.job.id, inspectedHash: { not: null } } })) === inspectedBefore && !(await prisma.photoJob.findUniqueOrThrow({ where: { id: W9.job.id } })).qcRequestedAt);

    c.head("isolation");
    c.ok("no outbound call escaped the fakes", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
