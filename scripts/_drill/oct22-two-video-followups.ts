// ---------------------------------------------------------------------------
// DRILL: TWO-VIDEO JOBS, FINISHED (audit H4a-e, Oct 22 2026).
//
//   DRILL_PORT=6995 node scripts/_drill/run-all.cjs scripts/_drill/oct22-two-video-followups.ts
//
// 538 Onward Ave's second reel was split off by the order sync six hours after
// the upload page was submitted and the edit card minted: the card still said
// "Premium reel…", John was never told, nobody asked for video 2's
// instructions. And three code paths still read a two-video job as one.
//   1. A video added mid-job: the real order reconcile adds it, the edit card
//      names both videos, John's job-ping bell names video 2, the timeline says
//      it; a second run says nothing new; a job not yet with the editor is left
//      to the normal flow.
//   2. The morning nudge asks for the added video's instructions, on its own
//      claim (the 10 AM ask that morning does not swallow it).
//   3. The upload page: a second video marked "couldn't complete", or waiting
//      on a second shoot, no longer blocks the submit.
//   4. A client text on a two-video job never guesses which video to reopen.
//   5. The agency packet labels the job's instructions as video 1's.
// Isolated PGlite; nothing leaves the process.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6995);
const REPO = fs.realpathSync(path.resolve(__dirname, "../.."));

// ---- the clock: Thu Oct 22 2026, 7:00 PM ET ----------------------------------------
const RealDate = Date;
const SIM = RealDate.parse("2026-10-22T23:00:00.000Z");
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;
const at = (iso: string) => new RealDate(iso);

installNextStubs();
const fence = fenceFetch();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const warn = console.warn;
  try {
    const { prisma } = await import("@/lib/prisma");
    const aryeo = await import("@/lib/integrations/aryeo");
    const dout = await import("@/lib/deliverableOutputs");
    const { cutSlots } = await import("@/lib/reviewCuts");
    const { establishSession } = await import("@/lib/auth/session");

    const products: [string, string[], string, string | null, string][] = [
      ["Social Influencer", ["PHOTOS", "SOCIAL_REEL", "DRONE_PHOTO", "FLOORPLAN"], "premium", "premium_social_reel", "MAIN"],
      ["Standard Video Highlight Reel", ["SOCIAL_REEL", "DRONE_PHOTO"], "standard", "standard_reel", "MAIN"],
      ["Community Photography", ["PHOTOS"], "standard", null, "ADDON"],
    ];
    for (const [i, [title, types, tier, style, type]] of products.entries()) {
      await prisma.product.create({ data: { aryeoId: `vf-p${i}`, title, type, mediaTypes: JSON.stringify(types), videoTier: tier, videoStyle: style, serviceKind: "service", videoQuantity: 1 } });
    }
    await aryeo.loadManualProductMap(true);
    const line = (title: string, quantity = 1, i = 0) => ({ id: `line-${title}-${i}`, title, quantity, amount: 10000, is_canceled: false }) as never;
    const JOE = [line("Community Photography"), line("Standard Video Highlight Reel"), line("Zillow Showcase 3D Tour Add-on"), line("Social Influencer")];

    // ---- the people ----
    const harrisonTm = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "harrison-vf@drill.invalid", role: "PHOTOGRAPHER", active: true } });
    const harrison = await prisma.appUser.create({ data: { email: "harrison-vf@drill.invalid", name: "Harrison Drill", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: harrisonTm.id } });
    await prisma.appSetting.create({ data: { key: "upload-ack-harrison-vf@drill.invalid", value: "true" } });
    await prisma.teamMember.create({ data: { name: "James Drill", email: "james-vf@drill.invalid", role: "PHOTOGRAPHER", active: true, creativeManager: true } });
    const johnTm = await prisma.teamMember.create({ data: { name: "John Mark", email: "john-vf@drill.invalid", role: "EDITOR", active: true } });
    await prisma.appUser.create({ data: { email: "john-vf@drill.invalid", name: "John Mark", role: "EDITOR", status: "ACTIVE", teamMemberId: johnTm.id, editorKey: "john" } });
    const client = await prisma.client.create({ data: { name: "Joe Drill" } });
    const SHOT = at("2026-10-21T12:00:00.000Z"); // Wed Oct 21, 8:00 AM ET
    const HANDED = at("2026-10-22T16:06:31.000Z"); // Thu Oct 22, 12:06 PM ET (Jordan, at the office)
    const WORDS = "STYLE: Fast-Paced\n\nCOLOR PROFILE: S-Log3, D-LogM\n\nVISION FOR THE EDIT\nFollow the script and the inspo clips, the Happy Gilmore drive is the hook and the town tour closes it.";
    let n = 0;
    const joeJob = async (street: string, opts: { handed?: Date | null } = {}) => {
      n++;
      const handed = opts.handed === undefined ? HANDED : opts.handed;
      const p = await prisma.project.create({
        data: {
          title: `${street}, Phoenixville, PA 19460`, addressLine: street, clientId: client.id, status: handed ? "REVIEW" : "SHOT", shootDate: SHOT,
          photographerId: harrisonTm.id, editorId: johnTm.id, aryeoOrderId: `order-vf-${n}`, reelScript: "Happy Gilmore: The First Drive", scriptConfirmedAt: SHOT,
          videoInstructions: WORDS, debriefSubmittedAt: handed, videoHandoffAt: handed, photosHandoffAt: handed, videoHandoffBy: handed ? "Jordan Drill" : null, uploadedAt: at("2026-10-22T03:01:20.000Z"),
          appointments: { create: [{ aryeoId: `appt-vf-${n}`, startAt: SHOT, status: "SCHEDULED", title: street }] },
          deliverables: {
            create: [
              { type: "PHOTOS", label: "Photos", productTitle: "Social Influencer", status: "DONE", createdAt: at("2026-10-14T19:41:32.893Z") },
              { type: "SOCIAL_REEL", label: "Social Influencer", productTitle: "Social Influencer", videoStyle: "premium_social_reel", status: "UPLOADED", createdAt: at("2026-10-14T19:41:32.893Z") },
            ],
          },
          orderItems: { create: ["Community Photography", "Social Influencer"].map((t, i) => ({ aryeoId: `oi-vf-${n}-${i}`, title: t, quantity: 1, amount: 100 })) },
        },
        select: { id: true },
      });
      await dout.ensureOutputsForProject(p.id);
      return p.id;
    };
    const card = (projectId: string, street: string) => prisma.smartTask.create({
      data: {
        taskType: "edit_video", status: "OPEN", assignedKey: "john", assignedManually: true, projectId, dedupeKey: `edit-video-${projectId}`,
        title: `Edit — ${street}`, summary: `Premium reel for ${street}. Raws are in — cut the video. Delivery due Oct 24 (set by the office).`, source: "system", priority: "HIGH", dueAt: at("2026-10-24T18:07:00Z"),
      },
    });

    // =====================================================================
    c.head("1 · A video the order adds mid-job: card, editor, timeline");
    // =====================================================================
    const job = await joeJob("538 Onward Ave");
    await card(job, "538 Onward Ave");
    c.ok("before: one video owed, the card says \"Premium reel\"", (await cutSlots(job)).length === 1);
    console.warn = () => {};
    const res = await aryeo.reconcileDeliverablesToOrder(job, { id: "order-vf-1", number: 1709, items: JOE } as never);
    console.warn = warn;
    c.ok("the real order reconcile adds the standard reel", res.added.includes("Standard Video Highlight Reel"), JSON.stringify(res));
    const slots = await cutSlots(job);
    const after = await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `edit-video-${job}` } });
    c.ok("the edit card's title names both: \"Edit 2 videos — 538 Onward Ave\"", after.title === "Edit 2 videos — 538 Onward Ave", after.title);
    c.ok("…and its text lists each video", (after.summary ?? "").startsWith(`2 videos for 538 Onward Ave (${slots.map((s) => s.label).join(", ")})`) && /cut each video/.test(after.summary ?? ""), after.summary ?? "");
    c.ok("…still John's (a hand-picked editor is never re-routed)", after.assignedKey === "john" && after.assignedManually);
    const bells = await prisma.notification.findMany({ where: { dedupeKey: { startsWith: `video-added-${job}` } } });
    c.ok("John's job-ping bell names video 2", bells.length === 1 && bells[0].kind === "raws_landed" && bells[0].userKey === "editor:john" && /^Another video on 538 Onward Ave: video 2 \(Standard Reel\)/.test(bells[0].title) && !/—/.test(bells[0].title), JSON.stringify(bells.map((b) => [b.kind, b.userKey, b.title])));
    const line1 = await prisma.activity.findFirst({ where: { projectId: job, body: { startsWith: "Another video was added after the edit started" } } });
    c.ok("the timeline says it, and what Harrison will be asked", !!line1 && /video 2 \(Standard Reel\)/.test(line1.body) && /John Mark was told/.test(line1.body) && /Harrison is asked for the instructions for video 2/.test(line1.body), line1?.body ?? "");
    console.warn = () => {};
    await aryeo.reconcileDeliverablesToOrder(job, { id: "order-vf-1", number: 1709, items: JOE } as never);
    console.warn = warn;
    c.ok("a second sync says nothing new (no second bell, no second line)", (await prisma.notification.count({ where: { dedupeKey: { startsWith: `video-added-${job}` } } })) === 1 && (await prisma.activity.count({ where: { projectId: job, body: { startsWith: "Another video was added" } } })) === 1);
    // A job not handed to editing yet: the normal flow shows every video.
    const early = await joeJob("540 Onward Ave", { handed: null });
    console.warn = () => {};
    await aryeo.reconcileDeliverablesToOrder(early, { id: "order-vf-2", number: 1710, items: JOE } as never);
    console.warn = warn;
    c.ok("not handed off yet: no bell, no line (the upload page already shows both videos)", (await prisma.notification.count({ where: { dedupeKey: { startsWith: `video-added-${early}` } } })) === 0 && !(await prisma.activity.findFirst({ where: { projectId: early, body: { startsWith: "Another video was added" } } })));
    const { announceVideosAddedMidJob } = await import("@/lib/videoAddedMidJob");
    const dry = await announceVideosAddedMidJob(early, [slots[1] ? `${(await cutSlots(early))[1].deliverableId}:1` : ""], { dryRun: true });
    c.ok("…and says why", dry?.skipped?.startsWith("not handed to editing yet") === true, JSON.stringify(dry));
    c.ok("the reconcile calls it with the new video keys", /announceVideosAddedMidJob\(rowHome, added/.test(fs.readFileSync(path.join(REPO, "src/lib/integrations/aryeo.ts"), "utf8")));

    // =====================================================================
    c.head("2 · The morning nudge asks for the added video's instructions");
    // =====================================================================
    const mi = await import("@/lib/missingInstructions");
    c.ok("what is missing now: video 2's instructions (the page itself was submitted)", JSON.stringify(await mi.missingInstructionsFor(job)) === JSON.stringify({ video: ["the instructions for video 2 (Standard Reel)"], photos: [] }), JSON.stringify(await mi.missingInstructionsFor(job)));
    // This morning's 10 AM ask already went (before the video existed).
    await prisma.appSetting.create({ data: { key: `instructions_missing:${job}:2026-10-22`, value: JSON.stringify({ state: "sent", at: "2026-10-22T14:01:00.921Z", morning: 1, to: ["Harrison Drill"], missing: ["the flow and vision for the edit"] }) } });
    const run = await mi.sweepMissingInstructions(new Date(), { projectIds: [job] });
    const claim = await prisma.appSetting.findUnique({ where: { key: `instructions_missing:${job}:2026-10-22:added` } });
    c.ok("the sweep asks today anyway, on its own claim", "considered" in run && run.considered === 1 && !!claim && JSON.parse(claim.value).state === "sent", JSON.stringify(run));
    const asked = await prisma.activity.findFirst({ where: { projectId: job, body: { contains: "the missing instructions" } }, orderBy: { createdAt: "desc" } });
    c.ok("…naming video 2's instructions, as a first ask (not \"still\")", !!asked && /Missing: the instructions for video 2 \(Standard Reel\)\./.test(asked.body), asked?.body ?? "");
    const jamesBell = await prisma.notification.findFirst({ where: { kind: "instructions_missing", dedupeKey: { startsWith: `instructions-missing-${job}-2026-10-22:added` } } });
    c.ok("James is copied on the same ask (his own bell row)", !!jamesBell && jamesBell.title === "Instructions missing: 538 Onward Ave" && /^tm:/.test(jamesBell.userKey ?? ""), JSON.stringify([jamesBell?.title, jamesBell?.userKey]));
    const run2 = await mi.sweepMissingInstructions(new Date(), { projectIds: [job] });
    c.ok("asked once this morning", "considered" in run2 && run2.sent.length === 0 && run2.notSent.length === 0, JSON.stringify(run2));

    // =====================================================================
    c.head("3 · The upload page: couldn't complete / waiting never blocks");
    // =====================================================================
    const fresh = await joeJob("550 Onward Ave", { handed: null });
    console.warn = () => {};
    await aryeo.reconcileDeliverablesToOrder(fresh, { id: "order-vf-3", number: 1711, items: JOE } as never);
    console.warn = warn;
    await establishSession(harrison.id);
    const { finalizeUpload, markDeliverableNotCompleted } = await import("@/app/upload/actions");
    const ANSWERS = {
      editorBrief: "", force: true, cullingConfirmed: true, shotOrder: { mode: "front-to-back" as const }, nothingToRemove: true, removalNotes: "",
      videoInstructions: WORDS, scriptConfirm: { state: "as-written" as const }, sawScript: true, laterVideoInstructions: {} as Record<string, string>,
    };
    const blocked = await finalizeUpload(fresh, ANSWERS);
    c.ok("control: video 2 with no words is refused, by name", /video 2 \(Standard Reel\)/.test(String(blocked.blocked)), String(blocked.blocked));
    const std = await prisma.deliverable.findFirstOrThrow({ where: { projectId: fresh, productTitle: "Standard Video Highlight Reel" } });
    const marked = await markDeliverableNotCompleted(std.id, "Agent cancelled the standard reel on site");
    const through = await finalizeUpload(fresh, ANSWERS);
    c.ok("video 2 marked couldn't complete: the submit goes through", marked.ok && !through.blocked, JSON.stringify(through).slice(0, 200));
    const held = await joeJob("552 Onward Ave", { handed: null });
    console.warn = () => {};
    await aryeo.reconcileDeliverablesToOrder(held, { id: "order-vf-4", number: 1712, items: JOE } as never);
    console.warn = warn;
    const heldSlot = (await cutSlots(held))[1];
    await import("@/lib/secondShoot").then((m) => m.markVideoWaitingOnShoot({ projectId: held, key: `${heldSlot.deliverableId}:${heldSlot.slot}`, note: "Half shot", actor: "Jordan", kick: false }));
    const throughHeld = await finalizeUpload(held, ANSWERS);
    c.ok("video 2 waiting on a second shoot: the submit goes through (the color check used to run first)", !throughHeld.blocked, JSON.stringify(throughHeld).slice(0, 200));
    const portal = fs.readFileSync(path.join(REPO, "src/components/upload/UploadPortal.tsx"), "utf8");
    c.ok("the page asks the same: a video marked couldn't complete owes no instructions", /if \(notDone\[deliverableId\] \|\| deliverables\.some\(\(d\) => d\.id === deliverableId && d\.waivedAt\)\) return \[\];/.test(portal) && portal.indexOf("const laterMissing") > portal.indexOf("const [notDone, setNotDone]"));

    // =====================================================================
    c.head("4 · A client text on a two-video job reopens the one video she has seen");
    // =====================================================================
    const { soleApprovedVideo } = await import("@/lib/cutReopen");
    const [s1] = await cutSlots(job);
    const prem = await prisma.reviewSubmission.create({ data: { projectId: job, deliverableId: s1.deliverableId, slot: s1.slot, round: 1, status: "APPROVED", source: "upload", fileName: "premium.mp4", decidedAt: at("2026-10-22T20:00:00Z") } });
    // Audit H4c considered and not taken (Oct 22 2026): the client has only
    // seen the approved video, and client texts go straight to the editor.
    c.ok("two videos owed, one approved: that one (the only one she has seen)", (await soleApprovedVideo(job))?.submissionId === prem.id);
    const one = await joeJob("7 One Reel Rd");
    const [o1] = await cutSlots(one);
    const sub1 = await prisma.reviewSubmission.create({ data: { projectId: one, deliverableId: o1.deliverableId, slot: o1.slot, round: 1, status: "APPROVED", source: "upload", fileName: "one.mp4", decidedAt: at("2026-10-22T20:00:00Z") } });
    c.ok("one video owed and approved: that one, as before", (await soleApprovedVideo(one))?.submissionId === sub1.id);

    // =====================================================================
    c.head("5 · The agency packet: the job's instructions are video 1's");
    // =====================================================================
    const { buildEditorPacket } = await import("@/lib/editorPacket");
    const two = await buildEditorPacket(job);
    c.ok("two-video listing job: instructionsFor \"video 1 (…)\"", two?.manifest.job.instructionsFor === `video 1 (${slots[0].label})`, String(two?.manifest.job.instructionsFor));
    const single = await buildEditorPacket(one);
    c.ok("a one-video job carries no label (its packet hash is unchanged)", single !== null && single.manifest.job.instructionsFor === undefined && !("instructionsFor" in single.manifest.job));
    const pdfSrc = fs.readFileSync(path.join(REPO, "src/lib/editorPacket.ts"), "utf8");
    c.ok("the PDF heading reads \"Instructions from the shoot for video 1 (…)\" when labelled", /`Instructions from the shoot for \$\{manifest\.job\.instructionsFor\}`/.test(pdfSrc));

    c.ok("nothing left the process", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    console.warn = warn;
    c.summary();
    quiet.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
