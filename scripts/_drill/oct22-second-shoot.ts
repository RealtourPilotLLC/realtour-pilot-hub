// ---------------------------------------------------------------------------
// DRILL: ONE VIDEO WAITS ON A SECOND SHOOT (Oct 22 2026).
//
//   DRILL_PORT=6941 node scripts/_drill/run-all.cjs scripts/_drill/oct22-second-shoot.ts
//
// Jordan, about Sharra Mercer's 34 Oakland Rd (3 Premium Social Media Reels
// plus the Social Influencer package's reel): "there are 4 videos, but one of
// the videos is only half shot and will need a second appointment for it. So
// what do we do in that case?" The 4th video is set up and marked "Waiting on
// a second shoot" (lib/secondShoot): off every queue and clock until a later
// appointment's footage (or the office) releases it, then on its own clock.
//
// Isolated PGlite; nothing leaves the process.
//   1. Marking: the video leaves the editor's slots, the due and late checks,
//      at-risk and the behind alert; it says so everywhere with the note.
//   2. The other videos are unaffected: their dates, their queue row, and
//      they can be approved and are ready to send without it.
//   3. A job whose every video waits is off the queue and gets no edit card.
//   4. KPI: the late-upload and thin-instructions checks leave it alone.
//   5. The "N videos ordered, M set up" warning counts it as set up.
//   6. A later appointment's upload releases it, with its own clock; a
//      delivered job comes back for it.
//   7. The office's Release to the editor (and who may press it).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6941);
const REPO = fs.realpathSync(path.resolve(__dirname, "../.."));

// ---- the clock: Fri Oct 23 2026, 4:00 PM ET, moved on in section 6 ---------------
const RealDate = Date;
let SIM = RealDate.parse("2026-10-23T20:00:00.000Z");
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
    const rc = await import("@/lib/reviewCuts");
    const dout = await import("@/lib/deliverableOutputs");
    const ss = await import("@/lib/secondShoot");
    const core = await import("@/lib/secondShootCore");
    const vs = await import("@/lib/videoSetup");
    const { establishSession } = await import("@/lib/auth/session");
    const { deliveryPromiseFor } = await import("@/lib/tasks");

    for (const [i, [title, types, style]] of ([
      ["Premium Social Media Reel - Most Popular", ["SOCIAL_REEL", "DRONE_VIDEO"], "premium_social_reel"],
      ["Social Influencer", ["PHOTOS", "SOCIAL_REEL", "DRONE_PHOTO", "FLOORPLAN"], "premium_social_reel"],
      ["Standard Video Highlight Reel", ["SOCIAL_REEL", "DRONE_PHOTO"], "standard_reel"],
    ] as const).entries()) {
      await prisma.product.create({ data: { aryeoId: `ss-p${i}`, title, type: "MAIN", mediaTypes: JSON.stringify(types), videoTier: style.startsWith("premium") ? "premium" : "standard", videoStyle: style, serviceKind: "service", videoQuantity: 1 } });
    }
    await aryeo.loadManualProductMap(true);

    // ---- the people ----
    const harrisonTm = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "harrison-ss@drill.invalid", role: "PHOTOGRAPHER", active: true } });
    const harrison = await prisma.appUser.create({ data: { email: "harrison-ss@drill.invalid", name: "Harrison Drill", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: harrisonTm.id } });
    const jordan = await prisma.appUser.create({ data: { email: "jordan-ss@drill.invalid", name: "Jordan Drill", role: "OWNER", status: "ACTIVE" } });
    const client = await prisma.client.create({ data: { name: "Sharra Drill" } });

    // ---- Sharra's job: 3 premium reels on one line + the Social Influencer reel ----
    const SHOT = at("2026-10-19T13:00:00.000Z"); // Mon Oct 19, 9:00 AM ET
    const HANDED = at("2026-10-20T04:30:57.000Z");
    const OFFICE_DUE = at("2026-10-22T21:00:00.000Z"); // Thu Oct 22, 5:00 PM ET: the other videos are late
    const WORDS = "STYLE: Fast-Paced\n\nCOLOR PROFILE: S-Log3\n\nVISION FOR THE EDIT\nOpen on the front walk, then the kitchen island, the deck at golden hour and the agent's close by the fireplace.";
    let n = 0;
    const job = async (street: string, opts: {
      reels: { label: string; product: string; style?: string; quantity?: number }[];
      shot?: Date; handed?: Date | null; due?: Date | null; status?: string; words?: string | null; photos?: boolean; evidence?: string | null;
    }) => {
      n++;
      const p = await prisma.project.create({
        data: {
          title: `${street}, West Chester, PA 19382`, addressLine: street, clientId: client.id, status: (opts.status ?? "EDITING") as never,
          shootDate: opts.shot ?? SHOT, photographerId: harrisonTm.id, aryeoListingId: `L-ss-${n}`, aryeoOrderId: `O-ss-${n}`,
          videoInstructions: opts.words === undefined ? WORDS : opts.words, reelScript: "The porch, the kitchen, the deck.", scriptConfirmedAt: opts.shot ?? SHOT,
          debriefSubmittedAt: opts.handed === undefined ? HANDED : opts.handed, videoHandoffAt: opts.handed === undefined ? HANDED : opts.handed,
          dueOverrideAt: opts.due === undefined ? OFFICE_DUE : opts.due, overrideAt: opts.due === null ? null : at("2026-10-21T15:00:00Z"), overrideBy: opts.due === null ? null : "Jordan",
          statusEvidence: opts.evidence ?? null,
          createdAt: at("2026-10-14T14:29:47.000Z"),
          appointments: { create: [{ aryeoId: `appt-ss-${n}-1`, startAt: opts.shot ?? SHOT, status: "SCHEDULED", title: `#${n} ${street}` }] },
          deliverables: {
            create: [
              ...(opts.photos === false ? [] : [{ type: "PHOTOS" as const, label: "Photos", productTitle: "Social Influencer", status: "DONE" as const, createdAt: at("2026-10-14T14:29:47.700Z") }]),
              ...opts.reels.map((r, i) => ({ type: "SOCIAL_REEL" as const, label: r.label, productTitle: r.product, videoStyle: r.style ?? "premium_social_reel", quantity: r.quantity ?? 1, status: "UPLOADED" as const, uploadedAt: opts.handed === null ? null : HANDED, createdAt: at(`2026-10-14T14:29:47.${String(765 + i).padStart(3, "0")}Z`) })),
            ],
          },
          orderItems: { create: opts.reels.map((r, i) => ({ aryeoId: `oi-ss-${n}-${i}`, title: r.product, quantity: r.quantity ?? 1, amount: 100 })) },
        },
        select: { id: true },
      });
      await dout.ensureOutputsForProject(p.id);
      return p.id;
    };
    const SHARRA = [
      { label: "Premium Social Reel", product: "Premium Social Media Reel - Most Popular", quantity: 3 },
      { label: "Social Influencer", product: "Social Influencer" },
    ];
    const A = await job("34 Oakland Drill Rd", { reels: SHARRA, evidence: JSON.stringify({ present: ["Photos"], dropbox: { rawPhotos: 120, rawVideo: 40 } }) });
    await prisma.smartTask.create({ data: { taskType: "edit_video", title: "Edit 34 Oakland Drill Rd", projectId: A, assignedKey: "john", status: "OPEN" } });
    const slotsBefore = await rc.cutSlots(A);
    const fourth = slotsBefore[3];
    const fourthKey = `${fourth.deliverableId}:${fourth.slot}`;
    const fourthOut = await prisma.deliverableOutput.findUniqueOrThrow({ where: { deliverableId_slot: { deliverableId: fourth.deliverableId, slot: fourth.slot } } });
    // A date somebody had put on the 4th before anyone knew (so at-risk could see it).
    await prisma.deliverableOutput.update({ where: { id: fourthOut.id }, data: { promisedAt: at("2026-10-24T01:00:00Z"), promiseSource: "drill" } });
    const { videoDeliveryBoard } = await import("@/lib/videoDelivery");
    const { atRiskOutputs } = await import("@/lib/atRiskUpdates");
    const { behindReport } = await import("@/lib/behindAlert");
    const { buildEditorQueue } = await import("@/lib/editorQueue");
    const boardRows = async (id: string) => {
      const b = await videoDeliveryBoard({ fresh: true, now: new Date() });
      return (["late", "today", "upcoming", "review", "sending", "held", "finishing"] as const).flatMap((l) => b.lanes[l]).filter((r) => r.projectId === id);
    };
    const queueRow = async (id: string) => {
      const q = await buildEditorQueue();
      return { notDone: q.notDone.find((r) => r.id === id) ?? null, any: [...q.notDone, ...q.upcoming, ...q.done].find((r) => r.id === id) ?? null };
    };
    const lateBefore = (await boardRows(A)).filter((r) => r.late).length;
    const riskBefore = (await atRiskOutputs(new Date())).some((r) => r.outputId === fourthOut.id);
    const behindBefore = (await behindReport(new Date(), { fresh: true })).items.filter((i) => i.projectId === A).length;

    // =====================================================================
    c.head("1 · Marking the 4th video: off the queue, the due and late checks");
    // =====================================================================
    c.ok("before: 4 videos owed, the 4th is the Social Influencer reel", slotsBefore.length === 4 && fourth.slot === 1 && /Premium|Social/.test(fourth.label), slotsBefore.map((s) => s.label).join(" | "));
    c.ok("before: all 4 late on the video board, the 4th at risk, 4 in the behind alert", lateBefore === 4 && riskBefore && behindBefore === 4, JSON.stringify({ lateBefore, riskBefore, behindBefore }));
    const NOTE = "Half shot; needs a second appointment (Jordan, Oct 22)";
    const marked = await ss.markVideoWaitingOnShoot({ projectId: A, key: fourthKey, note: NOTE, actor: "Jordan Drill", kick: false });
    c.ok("marked: \"Video 4 ... is waiting on a second shoot\"", marked.ok && /^Video 4 \(.*\) is waiting on a second shoot/.test(marked.message) && !/—/.test(marked.message), marked.message);
    const stored = core.readSecondShoot((await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: fourthOut.id } })).briefJson);
    c.ok("stored on the video's own row (DeliverableOutput.briefJson.secondShoot): who, when, the note, the half-shot visit", !!stored && stored.by === "Jordan Drill" && stored.note === NOTE && stored.afterVisitAt === SHOT.toISOString() && !stored.releasedAt, JSON.stringify(stored));
    const owedNow = await rc.cutSlots(A);
    c.ok("the editor's slots: 3 (the 4th left out); with includeWaiting it is back, flagged", owedNow.length === 3 && !owedNow.some((s) => `${s.deliverableId}:${s.slot}` === fourthKey) && (await rc.cutSlots(A, { includeWaiting: true })).filter((s) => s.waitingOnShoot).length === 1);
    const outs = await dout.outputsForProject(A);
    const o4 = outs.find((o) => o.id === fourthOut.id)!;
    c.ok("the job's video list: the 4th says \"Waiting on a second shoot: Half shot; ...\", no due date", o4.detail.startsWith("Waiting on a second shoot: Half shot; needs a second appointment (Jordan, Oct 22)") && o4.promisedAt === null && o4.targetAt === null && !!o4.waitingOnShoot, `${o4.detail} · ${o4.promisedAt}`);
    c.ok("…and keeps its number (video 4 of 4)", o4.index === 4 && o4.total === 4);
    const states = (await rc.videoStatesFor([A])).get(A)!;
    c.ok("the video state: 3 owed, 1 waiting on a second shoot (said, not counted)", states.owed === 3 && states.waitingOnShoot === 1 && /1 waiting on a second shoot/.test(states.detail) && !!states.waitingLines?.[0]?.startsWith("Video 4 ("), JSON.stringify({ owed: states.owed, detail: states.detail, lines: states.waitingLines }));
    const qA = await queueRow(A);
    c.ok("the editor queue: the job stays for the other 3, the row says 1 waiting on a second shoot", !!qA.notDone && qA.notDone.videos === 3 && /3 to edit · 1 waiting on a second shoot/.test(qA.notDone.videoBreakdown ?? "") && /1 waiting on a second shoot/.test(qA.notDone.progressSummary ?? ""), JSON.stringify({ videos: qA.notDone?.videos, b: qA.notDone?.videoBreakdown, p: qA.notDone?.progressSummary }));
    const rowsA = await boardRows(A);
    c.ok("the video board (the behind alert's source): 3 videos late, the 4th not there at all", rowsA.length === 3 && rowsA.filter((r) => r.late).length === 3 && rowsA.every((r) => /Video [123] of 3/.test(r.label)), rowsA.map((r) => `${r.label}/${r.late}`).join(", "));
    c.ok("not at risk any more (its old date is ignored while it waits)", !(await atRiskOutputs(new Date())).some((r) => r.outputId === fourthOut.id));
    const behindAfter = (await behindReport(new Date(), { fresh: true })).items.filter((i) => i.projectId === A).length;
    c.ok("the behind alert counts 3 for the job, not 4", behindAfter === 3, String(behindAfter));
    const instr = await dout.videoInstructionsFor(A);
    c.ok("the upload page keeps its instructions box, flagged waiting with the note; no gap is owed for it", instr.length === 4 && instr[3].waiting === true && instr[3].waitingNote === NOTE && (await import("@/lib/perVideoInstructions")).laterVideoGap(instr[3]) === null);
    const again = await ss.markVideoWaitingOnShoot({ projectId: A, key: fourthKey, note: "Half shot; back on Oct 27", expectedAt: at("2026-10-27T16:00:00Z"), actor: "Kyle", kick: false });
    const stored2 = core.readSecondShoot((await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: fourthOut.id } })).briefJson)!;
    c.ok("marking again only updates the note and the expected appointment (who and when stay)", again.ok && stored2.note === "Half shot; back on Oct 27" && stored2.expectedAt === "2026-10-27T16:00:00.000Z" && stored2.by === "Jordan Drill" && stored2.at === stored!.at, JSON.stringify(stored2));
    await ss.markVideoWaitingOnShoot({ projectId: A, key: fourthKey, note: NOTE, actor: "Jordan", kick: false });
    // A brief save on the waiting video keeps the hold.
    const saved = await dout.saveOutputBrief({ outputId: fourthOut.id, projectId: A, sections: { mustShow: "The back deck" }, actor: "Jordan" });
    const both = (await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: fourthOut.id } })).briefJson;
    c.ok("a brief saved on it keeps the hold (and the brief reads as a brief)", saved.ok && core.isWaitingJson(both) && dout.readOutputBrief(both)?.sections.mustShow === "The back deck", both ?? "");

    // =====================================================================
    c.head("2 · The other videos are unaffected and can be delivered");
    // =====================================================================
    c.ok("videos 1 to 3 keep the office's date", outs.filter((o) => o.id !== fourthOut.id).every((o) => o.promisedAt?.getTime() === OFFICE_DUE.getTime() && !o.waitingOnShoot));
    const subs: string[] = [];
    for (const s of owedNow) {
      const sub = await prisma.reviewSubmission.create({ data: { projectId: A, deliverableId: s.deliverableId, slot: s.slot, round: 1, status: "APPROVED", source: "upload", fileName: `${s.slot}.mp4`, blobUrl: `https://drill.invalid/${s.deliverableId}-${s.slot}.mp4`, sizeBytes: 1000, decidedAt: at("2026-10-23T18:00:00Z"), decidedBy: "James" } });
      subs.push(sub.id);
    }
    await dout.refreshOutputsForProject(A);
    const st2 = (await rc.videoStatesFor([A])).get(A)!;
    c.ok("all 3 owed videos approved: the job's video is \"Approved\" (the 4th does not hold it)", st2.stage === "approved" && st2.approved === 3 && st2.owed === 3, `${st2.stage} · ${st2.detail}`);
    const qA2 = await queueRow(A);
    c.ok("the queue row reads Approved, nothing left to edit", qA2.notDone?.status === "Approved" && qA2.notDone?.videosToEdit === 0, JSON.stringify({ s: qA2.notDone?.status, e: qA2.notDone?.videosToEdit }));
    const { readyToSend } = await import("@/lib/readyToSend");
    const ready = await readyToSend({ projectId: A });
    const readyA = [...ready.ready, ...ready.rendering].filter((r) => r.projectId === A).length;
    c.ok("ready to send: the 3 approved videos, nothing waiting on the 4th", readyA === 3, String(readyA));
    const { videoUnitTally } = await import("@/lib/projectStatus");
    const outRows = await prisma.deliverableOutput.findMany({ where: { projectId: A }, select: { deliverableId: true, slot: true, category: true, deliveredAt: true, approvedAt: true, briefJson: true } });
    const tally = videoUnitTally([{ type: "SOCIAL_REEL", quantity: 4 }], outRows.filter((o) => !core.isWaitingJson(o.briefJson)));
    const src = fs.readFileSync(path.join(REPO, "src/lib/projectStatus.ts"), "utf8");
    c.ok("the delivery count leaves it out: 3 owed, 3 finished (the status engine filters the same way)", !!tally && tally.owed === 3 && tally.finished === 3 && /filter\(\(o\) => !isWaitingJson\(o\.briefJson\)\)/.test(src), JSON.stringify(tally));

    // =====================================================================
    c.head("3 · Every video waiting: off the queue, no edit card, no ping");
    // =====================================================================
    const ev = JSON.stringify({ present: [], dropbox: { rawPhotos: 0, rawVideo: 12 } });
    const B = await job("12 Half Shot Ln", { reels: [{ label: "Social Influencer", product: "Social Influencer" }], photos: false, evidence: ev, status: "SHOT" });
    const C = await job("14 Fully Shot Ln", { reels: [{ label: "Social Influencer", product: "Social Influencer" }], photos: false, evidence: ev, status: "SHOT" });
    c.ok("before: the job is on the editors' queue", !!(await queueRow(B)).notDone);
    const bOut = (await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: B } })).id;
    await ss.markVideoWaitingOnShoot({ projectId: B, outputId: bOut, note: "Rain; exteriors and the drone next week", actor: "Jordan", kick: false });
    c.ok("its only video waiting: off the editors' queue", !(await queueRow(B)).notDone);
    c.ok("…and off the video board (never late)", (await boardRows(B)).length === 0);
    const { ensureEditorHandoff } = await import("@/lib/tasks");
    console.warn = () => {};
    await ensureEditorHandoff(B);
    await ensureEditorHandoff(C);
    console.warn = warn;
    const cardB = await prisma.smartTask.count({ where: { projectId: B, taskType: "edit_video" } });
    const cardC = await prisma.smartTask.count({ where: { projectId: C, taskType: "edit_video" } });
    const routedB = (await prisma.project.findUniqueOrThrow({ where: { id: B } })).editorId;
    c.ok("no edit card, no routing, no \"Ready for editing\" for it (the same job not waiting gets its card)", cardB === 0 && !routedB && cardC === 1, JSON.stringify({ cardB, routedB, cardC }));

    // =====================================================================
    c.head("4 · KPI: late upload and thin instructions leave it alone");
    // =====================================================================
    const kpi = await import("@/lib/kpiEvidence");
    const evidence = async (day: string) => kpi.loadEvidence(harrisonTm.id, { startKey: day, endKey: day, start: at(`${day}T04:00:00Z`), windowEnd: new Date() }, new Date());
    // A Thursday shoot whose only video was half shot: the video half never submitted.
    const E = await job("16 Not In Yet Ct", { reels: [{ label: "Social Influencer", product: "Social Influencer" }], photos: false, shot: at("2026-10-22T13:00:00Z"), handed: null });
    const lateE = (await evidence("2026-10-22")).entries.some((e) => e.kind === "late_video" && e.projectId === E);
    await ss.markVideoWaitingOnShoot({ projectId: E, outputId: (await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: E } })).id, note: "Half shot", actor: "Jordan", kick: false });
    const lateE2 = (await evidence("2026-10-22")).entries.some((e) => e.kind === "late_video" && e.projectId === E);
    c.ok("\"Video not in yet\" before; nothing once its only video waits", lateE && !lateE2, JSON.stringify({ lateE, lateE2 }));
    // A Friday shoot handed in after the per-video rule: video 2 has no words of its own.
    const D = await job("18 Two Reels Way", { reels: [{ label: "Premium Social Reel", product: "Premium Social Media Reel - Most Popular" }, { label: "Social Influencer", product: "Social Influencer" }], shot: at("2026-10-23T13:00:00Z"), handed: at("2026-10-23T15:00:00Z") });
    const instrD = (await evidence("2026-10-23")).entries.find((e) => e.kind === "instructions" && e.projectId === D);
    c.ok("before: \"Video instructions incomplete\" naming video 2", !!instrD && instrD.detail.some((d) => /the instructions for video 2/.test(d)), JSON.stringify(instrD?.detail));
    const d2 = (await dout.videoInstructionsFor(D))[1];
    await ss.markVideoWaitingOnShoot({ projectId: D, outputId: d2.outputId!, note: "Agent intro next visit", actor: "Jordan", kick: false });
    const instrD2 = (await evidence("2026-10-23")).entries.find((e) => e.kind === "instructions" && e.projectId === D);
    c.ok("while video 2 waits: no entry (video 1's words are fine)", !instrD2, JSON.stringify(instrD2?.detail));
    await prisma.deliverableOutput.update({ where: { id: d2.outputId! }, data: { filmingNote: "Short." } });
    await prisma.project.update({ where: { id: D }, data: { videoInstructions: "STYLE: Fast-Paced\n\nCOLOR PROFILE: S-Log3\n\nVISION FOR THE EDIT\nThe porch." } });
    const thin = (await evidence("2026-10-23")).entries.find((e) => e.kind === "instructions" && e.projectId === D);
    c.ok("thin words on the WAITING video are not counted (only video 1's thin words are)", !!thin && !thin.detail.some((d) => /video 2/.test(d)), JSON.stringify(thin?.detail));
    const { handoffReadinessOf } = await import("@/lib/tasks");
    const dRow = await prisma.project.findUniqueOrThrow({ where: { id: D }, include: { deliverables: true, orderItems: true, photographer: true } });
    c.ok("the edit card's handoff check asks nothing of the waiting video", !(await handoffReadinessOf({ ...dRow, id: D, photographer: dRow.photographer })).gaps.some((g) => /video 2/.test(g.label)));

    // =====================================================================
    c.head("5 · \"N videos ordered, M set up\" counts it as set up");
    // =====================================================================
    c.ok("34 Oakland: 4 ordered, 4 set up while the 4th waits (no alarm)", (await vs.videoSetupGapFor(A)) === null);
    c.ok("…and the order really does sell 4", aryeo.orderedVideoCount(aryeo.deliverablesFromStoredItems([{ title: "Premium Social Media Reel - Most Popular", quantity: 3 }, { title: "Social Influencer", quantity: 1 }])) === 4);
    const pinned = await job("20 Pinned Rd", { reels: SHARRA });
    await prisma.project.update({ where: { id: pinned }, data: { videosOwedOverride: 3 } });
    c.ok("the old pin (3 owed) is quiet too, and lifting it is what sets up the 4th", (await vs.videoSetupGapFor(pinned)) === null && (await rc.cutSlots(pinned)).length === 3);

    // =====================================================================
    c.head("6 · A later appointment's upload releases it, on its own clock");
    // =====================================================================
    // The second appointment: Tue Oct 27, 9:00 AM ET. Now: Tue 2:00 PM ET.
    const SECOND = at("2026-10-27T13:00:00Z");
    await prisma.appointment.create({ data: { aryeoId: "appt-ss-A-2", projectId: A, startAt: SECOND, status: "SCHEDULED", title: "#2 34 Oakland Drill Rd" } });
    SIM = RealDate.parse("2026-10-27T18:00:00.000Z");
    // The other 3 were delivered meanwhile; the job is DELIVERED.
    for (const id of subs) await prisma.reviewSubmission.update({ where: { id }, data: { sentToClientAt: at("2026-10-24T14:00:00Z"), sentToClientBy: "Kyle" } });
    await dout.refreshOutputsForProject(A);
    await prisma.project.update({ where: { id: A }, data: { status: "DELIVERED", deliveredAt: at("2026-10-24T14:00:00Z") } });
    c.ok("delivered without it: off the Not Done list while the 4th waits", !(await queueRow(A)).notDone);
    let r = await ss.releaseFromUploads(A, { kick: false });
    c.ok("the visit happened but no video came in yet: still waiting", r.released.length === 0 && core.isWaitingJson((await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: fourthOut.id } })).briefJson));
    // The photographer ticks the Social Influencer reel uploaded at 1:00 PM ET.
    await prisma.deliverable.update({ where: { id: fourth.deliverableId }, data: { uploadedAt: at("2026-10-27T17:00:00Z") } });
    r = await ss.releaseFromUploads(A, { kick: false });
    const rel = await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: fourthOut.id } });
    const relHold = core.readSecondShoot(rel.briefJson);
    const own = deliveryPromiseFor(SECOND, [{ type: "SOCIAL_REEL", label: "Social Influencer", productTitle: "Social Influencer" }], false, null, { tier: "premium" });
    c.ok("released by the upload, its clock from the Oct 27 visit", r.released.includes(fourthOut.id) && !!relHold?.releasedAt && relHold.releasedHow === "upload" && relHold.clockFrom === SECOND.toISOString(), JSON.stringify(relHold));
    c.ok("due on its own premium turnaround from that shoot (not the office's Oct 22 date)", rel.promisedAt?.getTime() === own.at.getTime() && rel.promiseSource === "second-shoot" && rel.promiseAnchorAt?.getTime() === SECOND.getTime() && rel.promisedAt.getTime() > SECOND.getTime(), `${rel.promisedAt?.toISOString()} vs ${own.at.toISOString()}`);
    c.ok("it is a video again everywhere: 4 slots, its row dated by its own clock", (await rc.cutSlots(A)).length === 4 && (await dout.outputsForProject(A)).find((o) => o.id === fourthOut.id)?.promisedAt?.getTime() === own.at.getTime());
    const qA3 = await queueRow(A);
    c.ok("the delivered job is back on the editors' queue for it, dated by the 4th's own clock", !!qA3.notDone && qA3.notDone.status === "Extra video owed" && qA3.notDone.dueISO === own.at.toISOString() && !qA3.notDone.late, JSON.stringify({ s: qA3.notDone?.status, due: qA3.notDone?.dueISO, late: qA3.notDone?.late }));
    const rowsA3 = await boardRows(A);
    c.ok("the video board: one row for it, not late, on its own date (the delivered 3 are not back)", rowsA3.filter((x) => x.cutStatus === null).length === 1 && rowsA3.every((x) => !x.late) && rowsA3.find((x) => x.cutStatus === null)?.promiseISO === own.at.toISOString(), rowsA3.map((x) => `${x.label}/${x.late}/${x.promiseISO}`).join(", "));
    const activity = await prisma.activity.findMany({ where: { projectId: A }, orderBy: { createdAt: "asc" }, select: { body: true } });
    c.ok("the job's history says it, in plain words", activity.some((a) => /marked waiting on a second shoot by Jordan Drill: Half shot/.test(a.body)) && activity.some((a) => /released to the editor: footage from the Oct 27 shoot is in\. Its own clock runs from/.test(a.body)) && !activity.some((a) => /—/.test(a.body) && /second shoot|released to the editor/.test(a.body)), activity.map((a) => a.body).slice(-2).join(" || "));
    // A later visit that uploaded only photos (a JPEG tick on photos) never releases a video.
    const F2 = await job("22 Photos Only Rd", { reels: SHARRA });
    const f2Out = (await rc.cutSlots(F2))[3];
    await ss.markVideoWaitingOnShoot({ projectId: F2, key: `${f2Out.deliverableId}:${f2Out.slot}`, note: "Half shot", actor: "Jordan", kick: false });
    await prisma.appointment.create({ data: { aryeoId: "appt-ss-F2-2", projectId: F2, startAt: SECOND, status: "SCHEDULED", title: "#2" } });
    await prisma.deliverable.updateMany({ where: { projectId: F2, type: "PHOTOS" }, data: { uploadedAt: at("2026-10-27T17:00:00Z") } });
    c.ok("a later visit with no video footage leaves it waiting", (await ss.releaseFromUploads(F2, { kick: false })).released.length === 0);
    c.ok("…and the upload page's video submit after that visit releases it", (await ss.releaseFromUploads(F2, { kick: false, extra: [new Date()] })).released.length === 1);
    const pure = core.secondShootVisitFor({ appointments: [{ startAt: SHOT, status: "SCHEDULED" }, { startAt: SECOND, status: "CANCELLED" }], afterVisitAt: SHOT, uploads: [new Date()], now: new Date(), dayStart: (await import("@/lib/datetime")).etDayStartUtc });
    c.ok("a cancelled second visit releases nothing (the photo split-job rule)", pure === null);

    // =====================================================================
    c.head("7 · The office's Release to the editor");
    // =====================================================================
    SIM = RealDate.parse("2026-10-28T14:00:00.000Z"); // Wed Oct 28, 10:00 AM ET
    const G = await job("24 Office Release Ave", { reels: [{ label: "Premium Social Reel", product: "Premium Social Media Reel - Most Popular" }, { label: "Standard Video Highlight Reel", product: "Standard Video Highlight Reel", style: "standard_reel" }] });
    const gOuts = await dout.outputsForProject(G);
    const actions = await import("@/app/projects/secondShootActions");
    await establishSession(harrison.id);
    const refused = await actions.markWaitingOnSecondShootAction({ projectId: G, outputId: gOuts[1].id, note: "x" });
    c.ok("a photographer cannot mark a video waiting", !refused.ok && !core.isWaitingJson((await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: gOuts[1].id } })).briefJson), refused.message);
    await establishSession(jordan.id);
    const viaAction = await actions.markWaitingOnSecondShootAction({ projectId: G, outputId: gOuts[1].id, note: "Agent was sick; reel next week", expectedDay: "2026-11-02" });
    const gHold = core.readSecondShoot((await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: gOuts[1].id } })).briefJson);
    c.ok("the office marks it (by the button's action), the expected appointment kept", viaAction.ok && gHold?.by === "Jordan Drill" && gHold.expectedAt?.startsWith("2026-11-02T") === true, JSON.stringify({ viaAction, gHold }));
    const rows = await ss.secondShootViewRows(G);
    c.ok("the control names each video and says which one waits, with the note and the date", rows.length === 2 && rows[1].waiting === "Waiting on a second shoot: Agent was sick; reel next week (second appointment Nov 2)" && rows[0].waiting === null && !rows.some((x) => /—/.test(`${x.label}${x.waiting ?? ""}`)), JSON.stringify(rows));
    await establishSession(harrison.id);
    c.ok("a photographer cannot release it", !(await actions.releaseSecondShootVideoAction({ projectId: G, outputId: gOuts[1].id })).ok);
    await establishSession(jordan.id);
    const released = await actions.releaseSecondShootVideoAction({ projectId: G, outputId: gOuts[1].id });
    const gRel = await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: gOuts[1].id } });
    const ownStd = deliveryPromiseFor(new Date(), [{ type: "SOCIAL_REEL", label: "Standard Video Highlight Reel", productTitle: "Standard Video Highlight Reel" }], false, null, { tier: "standard" });
    c.ok("Release to the editor: with no later visit its clock starts now, on ITS tier (standard, not the job's premium)", released.ok && core.readSecondShoot(gRel.briefJson)?.releasedHow === "office" && gRel.promisedAt?.getTime() === ownStd.at.getTime(), `${released.message} · ${gRel.promisedAt?.toISOString()} vs ${ownStd.at.toISOString()}`);
    c.ok("…and it is owed and on the queue again", (await rc.cutSlots(G)).length === 2 && (await queueRow(G)).notDone?.videos === 2);
    c.ok("releasing twice is refused", !(await actions.releaseSecondShootVideoAction({ projectId: G, outputId: gOuts[1].id })).ok);
    const approved = await ss.markVideoWaitingOnShoot({ projectId: A, key: owedNow[0] ? `${owedNow[0].deliverableId}:${owedNow[0].slot}` : "", note: "x", actor: "Jordan", kick: false });
    c.ok("a video with an approved cut cannot be held", !approved.ok && /already/.test(approved.message), approved.message);

    // =====================================================================
    c.head("8 · Wiring and words");
    // =====================================================================
    const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
    c.ok("the job page and the editor's brief carry the office's control", /<SecondShootCard projectId=\{project\.id\} \/>/.test(read("src/app/projects/[id]/page.tsx")) && /<SecondShootCard projectId=\{project\.id\} \/>/.test(read("src/app/edit/[id]/page.tsx")));
    c.ok("the Shoots board says it on the row", /waitingOnShoot: waitingOnShoot\.get\(j\.id\)/.test(read("src/lib/jobsBoard.ts")) && /data-waiting-on-shoot/.test(read("src/components/jobs/ShootsList.tsx")));
    c.ok("the upload page and the hourly sync release it", /releaseFromUploads\(projectId/.test(read("src/app/upload/actions.ts")) && /sweepSecondShoots/.test(read("src/app/api/cron/sync/route.ts")));
    const code = (p: string) => read(p).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    c.ok("no em dashes in the new words", !["src/lib/secondShoot.ts", "src/lib/secondShootCore.ts", "src/components/jobs/SecondShootControl.tsx", "src/components/jobs/SecondShootCard.tsx", "src/app/projects/secondShootActions.ts"].some((p) => /—/.test(code(p))));
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
