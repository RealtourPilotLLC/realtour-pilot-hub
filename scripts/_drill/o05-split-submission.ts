// ---------------------------------------------------------------------------
// DRILL: O05 / A31 — PHOTOS AND VIDEO ARE HANDED OFF SEPARATELY, and the
// video half is due by 8:00 AM the next day (Jordan, Sep 25 2026). Unified
// handoff batch 4.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//     NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/o05-split-submission.ts
//
// What it proves, OLD behaviour first:
//
//   1. OLD (fa9a2c9's finalizeUpload, loaded from git): the photos cannot go in
//      without the video brief — one submit, both halves' gates. And a submit
//      with NO scope on the new code writes exactly what the old one wrote
//      (same columns, same timeline lines) on a twin job.
//   2. Photos half on a photo+video job: its own stamp, the photo QC line
//      clears, the video fields are NOT written, the whole-page stamp stays
//      null — so the creative payroll still drops the shoot, shootEarnings
//      says "pending", the edit still waits on the wrap-up, the Waiting hold
//      stands and no "completed upload" line is written.
//   3. The video half's gates still apply to it; handed in, the whole-page
//      stamp lands ONCE, pay shows, the hold is released, one completed line.
//   4. A half re-submitted never re-stamps; an excused video lets the photos
//      complete the wrap-up; the office submitting stamps the office's name.
//   5. Both halves at the same moment from two devices: one whole-page stamp,
//      one completed line (the completion is a claim).
//   6. A pre-pay-gate job is never trapped by the gates.
//   7. Jordan's notice: the 10 PM chaser — same channel, switch, hour and
//      marker — says "photos are uploaded but the video is not … before
//      8:00 AM tomorrow" with the job's own portal link; the old wording is
//      byte-identical for a plain unsubmitted page; a second firing is silent.
//   8. The deadline: a Friday-night photos submit is due Saturday 8:00 AM; a
//      video half after that is recorded late on the timeline and counts as a
//      late upload in the photographer's reliability KPI — so does a video
//      still owed past it (said apart on the card); one on time does not. No
//      pay amount moves.
//  10. (review, Sep 25) A video EXCUSED after the photos half — the
//      photographer's "couldn't complete", the office's "Not required",
//      Aryeo dropping the line, or a hand edit the hourly net finds —
//      completes the whole wrap-up: My Pay shows the shoot, the KPI does not
//      score a late video nobody wanted. An excuse is never a submit.
//  11. (review, Sep 25) Photos handed in AFTER tonight's 10 PM chaser: the
//      photographer is told right away through the same text, once per job
//      (shared claim with the chaser); before the chaser hour the chaser
//      carries it; the switch off sends nothing.
//
// ISOLATION. PGlite on 127.0.0.1:5713 (DRILL_PORT overrides) through the shared
// harness; production is never opened. Every non-loopback call is fenced;
// OpenPhone is replaced at the module boundary and every text is recorded,
// never sent. AUTH_ENFORCE is on: real sessions, real guards.
//
// THE CLOCK is pinned to Friday Sep 25 2026, 21:00 ET and moved by hand.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5713);
const BASE = "fa9a2c9"; // the commit this batch starts from — never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock ------------------------------------------------------------
const RealDate = Date;
let SIM = RealDate.parse("2026-09-25T21:00:00-04:00");
class DrillDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(SIM);
    // @ts-expect-error — forwarding the real constructor's own overloads
    else super(...args);
  }
  static now(): number {
    return SIM;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = DrillDate as unknown as DateConstructor;
const setClock = (iso: string) => { SIM = RealDate.parse(iso); };

installNextStubs();
const fence = fenceFetch();

// ---- OpenPhone, replaced at the module boundary ---------------------------
const texts: { to: string; text: string }[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/openphone",
  (loaded) => {
    const m = loaded as Record<string, unknown> & { OpenPhone: Record<string, unknown> };
    return {
      ...m,
      defaultOpenPhoneNumber: async () => "+15555550100",
      OpenPhone: {
        ...m.OpenPhone,
        sendMessage: async (_from: string, to: string, text: string) => { texts.push({ to, text }); return { id: `msg-${texts.length}` }; },
      },
    };
  },
);

function writeBaseCopies(): { dir: string; actions: string; digest: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "o05-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const actions = path.join(dir, "uploadActions.base.ts");
  fs.writeFileSync(actions, point(show("src/app/upload/actions.ts")));
  const digest = path.join(dir, "uploadDigest.base.ts");
  fs.writeFileSync(digest, point(show("src/lib/uploadDigest.ts")));
  return { dir, actions, digest };
}

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const { finalizeUpload, markDeliverableNotCompleted } = await import("@/app/upload/actions");
  const { establishSession } = await import("@/lib/auth/session");
  const { computePayroll } = await import("@/lib/payroll");
  const { shootEarnings } = await import("@/lib/shoot");
  const { specsForProject, ensureEditorHandoff } = await import("@/lib/tasks");
  const { QC_LABEL_PAGE_SUBMITTED } = await import("@/lib/debrief");
  const { UPLOAD_COMPLETED_BODY } = await import("@/lib/uploadSummary");
  const { videoHalfDueAt, videoHalfClock } = await import("@/lib/handoff");
  const digest = await import("@/lib/uploadDigest");
  const { scoreQuarter } = await import("@/lib/kpi");
  const base = writeBaseCopies();
  const oldActions = (await import(base.actions)) as { finalizeUpload: (id: string, data: unknown) => Promise<Record<string, unknown>> };
  const oldDigest = (await import(base.digest)) as { nagText: (first: string, streets: string[]) => string };

  // ---- the world ---------------------------------------------------------
  const client = await prisma.client.create({ data: { name: "Split Client TEST" }, select: { id: true } });
  const harrisonTm = await prisma.teamMember.create({
    data: { name: "Harrison Drill", email: "harrison-o05@drill.invalid", role: "PHOTOGRAPHER", phone: "6105550142", active: true, payPercent: 0.35, payFloor: 100 },
    select: { id: true },
  });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-o05@drill.invalid", role: "ADMIN" } });
  const harrison = await prisma.appUser.create({ data: { email: "harrison-o05@drill.invalid", name: "Harrison Drill", role: "PHOTOGRAPHER", status: "ACTIVE" }, select: { id: true } });
  const kyle = await prisma.appUser.create({ data: { email: "kyle-o05@drill.invalid", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  const asHarrison = () => establishSession(harrison.id);
  const asKyle = () => establishSession(kyle.id);
  // The chaser's switch and hour (Settings → Internal alerts) are not needed:
  // sendNightlyUploadNags is the chaser itself; the route decides the hour.

  const SHOOT_FRI = new Date("2026-09-25T10:00:00-04:00");
  let n = 0;
  const job = async (street: string, opts: { shootDate?: Date; uploadedAt?: Date; reelOnly?: boolean; photosOnly?: boolean } = {}) => {
    n++;
    // A full listing video: the old name-only gate and the new stamp-first
    // one both demand the photographer's instructions for it, so section 1
    // compares like with like (the reel case is b4-uploads' §7.4 drill).
    const rows: { type: "PHOTOS" | "VIDEO"; label: string; quantity: number; videoStyle?: string }[] = [];
    if (!opts.reelOnly) rows.push({ type: "PHOTOS", label: "Photos", quantity: 1 });
    if (!opts.photosOnly) rows.push({ type: "VIDEO", label: "Listing Video", quantity: 1, videoStyle: "standard_cinematic" });
    const p = await prisma.project.create({
      data: {
        title: `${street}, Emmaus, PA`, clientId: client.id, status: "SCHEDULED", shootDate: opts.shootDate ?? SHOOT_FRI,
        photographerId: harrisonTm.id, price: 400 + n, uploadedAt: opts.uploadedAt ?? null,
        deliverables: { create: rows },
      },
      select: { id: true },
    });
    return p.id;
  };
  const PHOTO_ANSWERS = {
    editorBrief: "",
    force: true,
    cullingConfirmed: true,
    shotOrder: { mode: "front-to-back" as const },
    removalNotes: "Trash cans in exterior 3",
    nothingToRemove: false,
  };
  const VIDEO_ANSWERS = {
    editorBrief: "",
    force: true,
    videoInstructions: "COLOR PROFILE: iPhone\n\nEDITING NOTES\nOpen on the kitchen island, then the pool",
    scriptConfirm: null,
    sawScript: false,
  };
  const ALL = { ...PHOTO_ANSWERS, ...VIDEO_ANSWERS };
  const lines = (projectId: string) => prisma.activity.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { type: true, body: true } });
  const fileLines = async (projectId: string) => (await lines(projectId)).filter((a) => a.type === "FILE" && a.body === UPLOAD_COMPLETED_BODY).length;
  const creativeLine = async (projectId: string) => {
    const rows = await computePayroll(new Date("2026-09-01T00:00:00-04:00"), new Date("2026-09-30T23:59:59-04:00"), { forCreativeEyes: true });
    return rows.flatMap((p) => p.jobs).find((j) => j.projectId === projectId) ?? null;
  };
  const ownerLine = async (projectId: string) => {
    const rows = await computePayroll(new Date("2026-09-01T00:00:00-04:00"), new Date("2026-09-30T23:59:59-04:00"));
    return rows.flatMap((p) => p.jobs).find((j) => j.projectId === projectId) ?? null;
  };
  const qcDone = async (projectId: string) => {
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { deliverables: true } });
    // Asked as a shot job: the QC card exists once the shoot is in, and the
    // question here is only whether its "page submitted" line is done.
    const specs = specsForProject({
      status: "SHOT", title: p.title, shootDate: p.shootDate, deliverables: p.deliverables,
      debriefSubmittedAt: p.debriefSubmittedAt, photosHandoffAt: p.photosHandoffAt,
    });
    const item = specs.flatMap((s) => s.checklist).find((i) => i.label === QC_LABEL_PAGE_SUBMITTED);
    return item ? item.done : null;
  };

  await asHarrison();

  // =======================================================================
  c.head("1 · OLD (fa9a2c9): one submit, both halves — and no scope is still exactly that");
  const oldJob = await job("1 Old Way");
  const oldPhotosOnly = await oldActions.finalizeUpload(oldJob, PHOTO_ANSWERS);
  c.ok("OLD: the photos cannot go in without the video brief", typeof oldPhotosOnly.blocked === "string" && /video instructions/i.test(String(oldPhotosOnly.blocked)), String(oldPhotosOnly.blocked));
  const twinOld = await job("2 Twin Old");
  const twinNew = await job("2 Twin New");
  await prisma.appSetting.create({ data: { key: `queue-waiting:${twinOld}`, value: JSON.stringify({ by: "Kyle", at: "2026-09-25T12:00:00Z" }) } });
  await prisma.appSetting.create({ data: { key: `queue-waiting:${twinNew}`, value: JSON.stringify({ by: "Kyle", at: "2026-09-25T12:00:00Z" }) } });
  const ro = await oldActions.finalizeUpload(twinOld, ALL);
  const rn = await finalizeUpload(twinNew, ALL);
  c.ok("both whole-page submits land", !!ro.pdfPath && !!rn.pdfPath);
  const cols = async (id: string) => {
    const p = await prisma.project.findUniqueOrThrow({ where: { id } });
    return {
      status: p.status, editorBrief: p.editorBrief, shotOrderNotes: p.shotOrderNotes, removalNotes: p.removalNotes,
      videoInstructions: p.videoInstructions, videosFilmed: p.videosFilmed, scriptConfirmNote: p.scriptConfirmNote,
      debrief: !!p.debriefSubmittedAt, culled: !!p.cullingConfirmedAt, uploaded: !!p.uploadedAt, pdf: !!p.editorPdfPath,
      photosHalf: p.photosHandoffAt, videoHalf: p.videoHandoffAt,
    };
  };
  c.ok("no scope → the same Project columns as the old code (no half stamps)", JSON.stringify(await cols(twinOld)) === JSON.stringify(await cols(twinNew)), JSON.stringify(await cols(twinNew)));
  const bodies = async (id: string) => (await lines(id)).map((a) => `${a.type}:${a.body}`).sort().join("|");
  c.ok("no scope → the same timeline lines as the old code", (await bodies(twinOld)) === (await bodies(twinNew)), await bodies(twinNew));
  c.ok("no scope → the Waiting hold is released, as before", (await prisma.appSetting.count({ where: { key: { in: [`queue-waiting:${twinOld}`, `queue-waiting:${twinNew}`] } } })) === 0);

  // =======================================================================
  c.head("2 · the photos half, on a photo + video job");
  const j1 = await job("11 Split St");
  await prisma.appSetting.create({ data: { key: `queue-waiting:${j1}`, value: JSON.stringify({ by: "Kyle", at: "2026-09-25T12:00:00Z" }) } });
  c.ok("before: the photo QC line waits on the page", (await qcDone(j1)) === false);
  const r1 = await finalizeUpload(j1, { ...ALL, scope: "photos" });
  const p1 = await prisma.project.findUniqueOrThrow({ where: { id: j1 } });
  c.ok("the photos half lands", !!r1.pdfPath && !r1.blocked, JSON.stringify(r1).slice(0, 160));
  c.ok("its own stamp and who", !!p1.photosHandoffAt && p1.photosHandoffBy === "Harrison Drill");
  c.ok("the whole-page stamp stays null; the video half is unstamped", !p1.debriefSubmittedAt && !p1.videoHandoffAt);
  c.ok("the photo answers are written", !!p1.cullingConfirmedAt && p1.removalNotes === "Trash cans in exterior 3" && !!p1.shotOrderNotes);
  c.ok("the video answers sent with it are NOT written", p1.videoInstructions === null);
  c.ok("raws-in (uploadedAt) and the SHOT move happen on the first half", !!p1.uploadedAt && p1.status === "SHOT");
  c.ok("the result says the video is still owed, due Sat 8:00 AM ET", r1.handoff?.wholeDone === false && r1.handoff?.videoDueISO === "2026-09-26T12:00:00.000Z", JSON.stringify(r1.handoff));
  c.ok("the photo QC line clears on the photos half", (await qcDone(j1)) === true);
  c.ok("the creative payroll still drops the shoot", (await creativeLine(j1)) === null);
  c.ok("shootEarnings still says pending", (await shootEarnings(j1, harrisonTm.id))?.state === "pending");
  c.ok("the Waiting hold stands (the photos are not the footage the edit waits on)", (await prisma.appSetting.count({ where: { key: `queue-waiting:${j1}` } })) === 1);
  const l1 = await lines(j1);
  c.ok("one 'Photos submitted' line, no 'completed upload' line", l1.filter((a) => a.body === "Photos submitted on the upload page by Harrison Drill.").length === 1 && (await fileLines(j1)) === 0, l1.map((a) => a.body).join(" | "));
  await prisma.project.update({ where: { id: j1 }, data: { statusEvidence: JSON.stringify({ expected: ["PHOTOS", "VIDEO"], present: [], missing: [], dropbox: { rawPhotos: 40, rawVideo: 6, finalPhotos: 0, finalVideo: 0 } }) } });
  await ensureEditorHandoff(j1).catch(() => {});
  const blocked1 = (await prisma.project.findUniqueOrThrow({ where: { id: j1 }, select: { handoffBlockedReason: true } })).handoffBlockedReason ?? "";
  c.ok("the edit still waits on the video wrap-up", /wrap-up on the upload page/.test(blocked1), blocked1);

  // =======================================================================
  c.head("3 · the video half");
  const gated = await finalizeUpload(j1, { ...PHOTO_ANSWERS, scope: "video", videoInstructions: "COLOR PROFILE: iPhone" });
  c.ok("the video half's own gate still applies to it", typeof gated.blocked === "string" && /instructions/i.test(gated.blocked), gated.blocked);
  setClock("2026-09-25T21:40:00-04:00");
  const r2 = await finalizeUpload(j1, { ...VIDEO_ANSWERS, scope: "video" });
  const p2 = await prisma.project.findUniqueOrThrow({ where: { id: j1 } });
  c.ok("the video half lands, on time", !!r2.pdfPath && r2.handoff?.videoLate === false && r2.handoff?.wholeDone === true, JSON.stringify(r2.handoff));
  c.ok("its own stamp; the whole-page stamp lands now", !!p2.videoHandoffAt && !!p2.debriefSubmittedAt);
  c.ok("the video answers are written; the photo stamp did not move", !!p2.videoInstructions && p2.photosHandoffAt?.getTime() === p1.photosHandoffAt?.getTime());
  c.ok("uploadedAt is the first half's, not re-stamped", p2.uploadedAt?.getTime() === p1.uploadedAt?.getTime());
  c.ok("the Waiting hold is released by the video half", (await prisma.appSetting.count({ where: { key: `queue-waiting:${j1}` } })) === 0);
  c.ok("exactly one 'completed upload' line", (await fileLines(j1)) === 1);
  c.ok("the shoot now shows in the creative payroll", !!(await creativeLine(j1)));
  c.ok("no late line for a video on time", !(await lines(j1)).some((a) => a.body.startsWith("Video half submitted late")));

  // =======================================================================
  c.head("4 · re-submits, excused halves, the office");
  const stampBefore = p2.debriefSubmittedAt!.getTime();
  const r3 = await finalizeUpload(j1, { ...PHOTO_ANSWERS, scope: "photos", removalNotes: "Trash cans and a hose" });
  const p3 = await prisma.project.findUniqueOrThrow({ where: { id: j1 } });
  c.ok("a photos re-submit lands and corrects the notes", !!r3.pdfPath && p3.removalNotes === "Trash cans and a hose");
  c.ok("…without re-stamping either half, raws-in or the whole page",
    p3.photosHandoffAt?.getTime() === p1.photosHandoffAt?.getTime() && p3.videoHandoffAt?.getTime() === p2.videoHandoffAt?.getTime() &&
    p3.uploadedAt?.getTime() === p1.uploadedAt?.getTime() && p3.debriefSubmittedAt?.getTime() === stampBefore);
  c.ok("…and no second 'completed upload' line", (await fileLines(j1)) === 1);

  const j2 = await job("22 Excused Rd");
  const reel2 = await prisma.deliverable.findFirstOrThrow({ where: { projectId: j2, type: "VIDEO" }, select: { id: true } });
  await markDeliverableNotCompleted(reel2.id, "Agent cancelled the reel on site");
  const r4 = await finalizeUpload(j2, { ...PHOTO_ANSWERS, scope: "photos" });
  const p4 = await prisma.project.findUniqueOrThrow({ where: { id: j2 } });
  c.ok("video marked not completed → the photos complete the whole wrap-up", r4.handoff?.wholeDone === true && !!p4.debriefSubmittedAt && !!p4.photosHandoffAt);
  c.ok("…with one 'completed upload' line", (await fileLines(j2)) === 1);

  const j3 = await job("33 Office Ave");
  await asKyle();
  await finalizeUpload(j3, { ...PHOTO_ANSWERS, scope: "photos" });
  const p5 = await prisma.project.findUniqueOrThrow({ where: { id: j3 } });
  c.ok("the office submitting the photos half stamps the office's name", p5.photosHandoffBy === "Kyle Drill");
  c.ok("…and says so on the timeline", (await lines(j3)).some((a) => a.body === "Photos submitted on the upload page by Kyle Drill."));
  await asHarrison();

  // =======================================================================
  c.head("5 · both halves at the same moment, from two devices");
  const j4 = await job("44 Race Ct");
  const [ra, rb] = await Promise.all([
    finalizeUpload(j4, { ...PHOTO_ANSWERS, scope: "photos" }),
    finalizeUpload(j4, { ...VIDEO_ANSWERS, scope: "video" }),
  ]);
  const p6 = await prisma.project.findUniqueOrThrow({ where: { id: j4 } });
  c.ok("both land", !!ra.pdfPath && !!rb.pdfPath, JSON.stringify([ra.blocked, rb.blocked]));
  c.ok("both half stamps and the whole-page stamp are set", !!p6.photosHandoffAt && !!p6.videoHandoffAt && !!p6.debriefSubmittedAt);
  c.ok("exactly one 'completed upload' line (the completion is a claim)", (await fileLines(j4)) === 1, String(await fileLines(j4)));
  c.ok("at least one of the two reports the whole wrap-up done", !!ra.handoff?.wholeDone || !!rb.handoff?.wholeDone);

  // =======================================================================
  c.head("6 · a pre-pay-gate job is never trapped");
  const j5 = await job("55 Legacy Way", { shootDate: new Date("2026-08-20T10:00:00-04:00"), uploadedAt: new Date("2026-08-20T20:00:00-04:00") });
  const r5 = await finalizeUpload(j5, { editorBrief: "just a note", force: true });
  c.ok("a legacy job's notes edit is not blocked by today's gates", !r5.blocked && !!r5.pdfPath, JSON.stringify(r5).slice(0, 120));

  // =======================================================================
  c.head("7 · Jordan's notice rides the 10 PM chaser");
  setClock("2026-09-25T21:00:00-04:00");
  const j6 = await job("6 Late Ln");
  const j7 = await job("7 Plain St");
  const j8 = await job("8 Owed Pl");
  await finalizeUpload(j6, { ...PHOTO_ANSWERS, scope: "photos" });
  await finalizeUpload(j8, { ...PHOTO_ANSWERS, scope: "photos" });
  void j7; // shot today, nothing submitted — the plain chaser line
  setClock("2026-09-25T22:00:00-04:00");
  texts.length = 0;
  const nag = await digest.sendNightlyUploadNags();
  c.ok("one text to the photographer (one per person per night)", nag.sent === 1 && texts.length === 1, JSON.stringify(nag));
  const body = texts[0]?.text ?? "";
  c.ok("it goes to his own phone, the existing channel", texts[0]?.to === "+16105550142");
  c.ok("the plain unsubmitted job keeps the old line", body.includes("Still waiting on today's upload page") && body.includes("7 Plain St"));
  c.ok("the split jobs are named with their own portal links",
    body.includes(`https://drill.invalid/upload/${j6}`) && body.includes(`https://drill.invalid/upload/${j8}`) && !/Still waiting[^]*6 Late Ln[^]*Finish tonight/.test(body));
  c.ok("…with Jordan's words: photos uploaded, video not, before 8:00 AM tomorrow, affects the KPI",
    /Photos are uploaded but the video is not/.test(body) && /before 8:00 AM tomorrow/.test(body) && /late upload on your KPIs/.test(body), body);
  c.ok("the old wording is byte-identical for a plain page", digest.nagText("Harrison", ["7 Plain St"]) === oldDigest.nagText("Harrison", ["7 Plain St"]));
  const single = digest.nagText("Harrison", [], [{ street: "6 Late Ln", url: "https://drill.invalid/upload/x" }]);
  c.ok("a single split job reads as one sentence with its link", single.includes("Photos are uploaded for 6 Late Ln, but the video is not. Please upload the video and submit it before 8:00 AM tomorrow:\nhttps://drill.invalid/upload/x"), single);
  const again = await digest.sendNightlyUploadNags();
  c.ok("the second firing the same night is silent (the existing marker)", again.sent === 0 && texts.length === 1, JSON.stringify(again));
  c.ok("no text copy uses an em dash in the new sentences", !/—/.test(single.split("\n\n").slice(1).join("\n\n")));

  // =======================================================================
  c.head("8 · the 8:00 AM deadline, the late mark and the KPI");
  c.ok("a Friday-night photos half is due Saturday 8:00 AM ET (the next day, weekend or not)",
    videoHalfDueAt(new Date("2026-09-25T21:00:00-04:00")).toISOString() === "2026-09-26T12:00:00.000Z");
  c.ok("a photos half just after midnight is due 8:00 AM that same next day",
    videoHalfDueAt(new Date("2026-09-26T00:30:00-04:00")).toISOString() === "2026-09-27T12:00:00.000Z");
  c.ok("the clock never starts when the video went in first", videoHalfClock({ photosHandoffAt: new Date("2026-09-25T22:00:00-04:00"), videoHandoffAt: new Date("2026-09-25T21:00:00-04:00") }) === null);
  const payBefore = await ownerLine(j6);
  setClock("2026-09-26T09:14:00-04:00");
  const late = await finalizeUpload(j6, { ...VIDEO_ANSWERS, scope: "video" });
  c.ok("a video half at 9:14 AM Saturday is recorded late", late.handoff?.videoLate === true, JSON.stringify(late.handoff));
  const lateLines = (await lines(j6)).filter((a) => a.body.startsWith("Video half submitted late"));
  c.ok("…once, on the timeline, naming the deadline", lateLines.length === 1 && /8:00 AM/.test(lateLines[0].body), lateLines.map((a) => a.body).join(" | "));
  const resubmitLate = await finalizeUpload(j6, { ...VIDEO_ANSWERS, scope: "video" });
  c.ok("a later re-submit of that half does not stamp a second late line", !!resubmitLate.pdfPath && (await lines(j6)).filter((a) => a.body.startsWith("Video half submitted late")).length === 1);
  const payAfter = await ownerLine(j6);
  c.ok("no pay effect: the owner's line for the shoot is the same amount", !!payBefore && !!payAfter && payBefore.shootPay === payAfter.shootPay, `${payBefore?.shootPay} → ${payAfter?.shootPay}`);
  const card = await scoreQuarter({ memberId: harrisonTm.id, now: new Date() });
  const rel = card.areas.find((a) => a.key === "reliability");
  const note = (rel?.notes ?? []).find((t) => /counts? as late because the video came in after 8:00 AM/.test(t)) ?? "";
  const owedNote = (rel?.notes ?? []).find((t) => /counts? as late because the video is still not in/.test(t)) ?? "";
  // Late: 6 Late Ln (handed in 9:14 AM). Still owed past 8:00 AM: 8 Owed Pl
  // and 33 Office Ave (photos in Friday, no video). On time: 11 Split St, the
  // race job, the twins. Excused: 22 Excused Rd.
  // (Moved to the review's law, Sep 25: the card used to fold the two still
  // owed into "the video came in after 8:00 AM" — a video that never came in.
  // Same three shoots counted; they are now said apart.)
  c.ok("the reliability KPI counts the video half that came in late (1 shoot)", /^1 shoot counts as late because the video came in after 8:00 AM/.test(note), note || JSON.stringify(rel?.notes));
  c.ok("…and the two still owed past 8:00 AM, in their own words (2 shoots)", /^2 shoots count as late because the video is still not in/.test(owedNote), owedNote || JSON.stringify(rel?.notes));
  const clockJ1 = videoHalfClock(await prisma.project.findUniqueOrThrow({ where: { id: j1 } }));
  c.ok("the on-time video (11 Split St) is not late", !!clockJ1 && !clockJ1.submittedLate && !clockJ1.overdue);

  // =======================================================================
  c.head("10 · the video excused AFTER the photos half: the whole wrap-up completes");
  const { waiveDeliverable } = await import("@/app/projects/deliverableActions");
  const { confirmNotRequiredTask } = await import("@/lib/tasks");
  const { reconcileWrapUps } = await import("@/lib/wrapUp");
  const { liveHandoffCategories } = await import("@/lib/handoff");
  const SHOOT_SAT = new Date("2026-09-26T10:00:00-04:00");
  const reelOf = async (pid: string) => (await prisma.deliverable.findFirstOrThrow({ where: { projectId: pid, type: "VIDEO" }, select: { id: true } })).id;
  const photosTonight = async (street: string) => {
    const pid = await job(street, { shootDate: SHOOT_SAT });
    const r = await finalizeUpload(pid, { ...PHOTO_ANSWERS, scope: "photos" });
    if (r.blocked || !r.pdfPath) throw new Error(`photos half did not land on ${street}: ${JSON.stringify(r).slice(0, 200)}`);
    return pid;
  };
  await asHarrison();
  setClock("2026-09-26T21:00:00-04:00"); // Sat 9 PM: the photos go in tonight
  const jA = await photosTonight("101 Excused After Ln");
  const jB = await photosTonight("102 Office Waived Rd");
  const jC = await photosTonight("103 Off The Order Ct");
  const jD = await photosTonight("104 Hand Edit Way");
  const jE = await job("105 Never Submitted Pl", { shootDate: SHOOT_SAT });
  setClock("2026-09-27T09:30:00-04:00"); // Sun 9:30 AM — past the 8:00 AM deadline
  // THE BUG, on the pure clock: the stamps alone read an excused video as owed
  // and overdue for good (the pre-fix KPI read exactly this).
  const pA0 = await prisma.project.findUniqueOrThrow({ where: { id: jA } });
  c.ok("the stamps alone (no videoLive) read the video owed and overdue — what the KPI used to count",
    videoHalfClock({ photosHandoffAt: pA0.photosHandoffAt, videoHandoffAt: null, debriefSubmittedAt: null })?.overdue === true);
  c.ok("…and told the video is not live, the clock owes nothing",
    videoHalfClock({ photosHandoffAt: pA0.photosHandoffAt, videoHandoffAt: null, debriefSubmittedAt: null, videoLive: false })?.owed === false);
  c.ok("before any excuse: no whole stamp, the shoot is off the creative payroll", !pA0.debriefSubmittedAt && (await creativeLine(jA)) === null);

  await markDeliverableNotCompleted(await reelOf(jA), "Agent cancelled the video at the door");
  const pA = await prisma.project.findUniqueOrThrow({ where: { id: jA } });
  c.ok("the photographer's own \"couldn't complete\" completes the wrap-up", !!pA.debriefSubmittedAt);
  c.ok("…stamped at the photos half's moment, not the excuse's", pA.debriefSubmittedAt?.getTime() === pA.photosHandoffAt?.getTime(), `${pA.debriefSubmittedAt?.toISOString()} vs ${pA.photosHandoffAt?.toISOString()}`);
  c.ok("…the shoot now shows in the creative payroll", !!(await creativeLine(jA)));
  const aLines = (await lines(jA)).map((a) => a.body);
  c.ok("…one timeline line saying why, and no 'completed upload' line (nobody submitted)",
    aLines.filter((b) => b.startsWith("Wrap-up complete: the photos went in") && /the video is no longer owed \(marked not completed/.test(b)).length === 1 && (await fileLines(jA)) === 0,
    aLines.filter((b) => b.startsWith("Wrap-up")).join(" | "));
  await markDeliverableNotCompleted(await reelOf(jA), "Agent cancelled the video at the door (and said so twice)");
  c.ok("…a second answer does not stamp or log it again", (await lines(jA)).filter((a) => a.body.startsWith("Wrap-up complete")).length === 1);

  await asKyle();
  const waived = await waiveDeliverable(await reelOf(jB), "Client dropped the reel this morning");
  await asHarrison();
  const pB = await prisma.project.findUniqueOrThrow({ where: { id: jB } });
  c.ok("the office's \"Not required\" completes it too", waived.ok && !!pB.debriefSubmittedAt && !!(await creativeLine(jB)), waived.message);
  c.ok("…and says the office excused it", (await lines(jB)).some((a) => /Wrap-up complete: .*marked not required by the office/.test(a.body)));

  // What the Aryeo order reconcile does when the line leaves the order.
  const reelC = await reelOf(jC);
  await prisma.deliverable.update({ where: { id: reelC }, data: { removedFromOrderAt: new Date(), removedFromOrderNote: "'Listing Video' is no longer on Aryeo order #1", notCompletedReason: null } });
  await confirmNotRequiredTask(reelC);
  const pC = await prisma.project.findUniqueOrThrow({ where: { id: jC } });
  c.ok("Aryeo dropping the line completes it", !!pC.debriefSubmittedAt && (await lines(jC)).some((a) => /it came off the order/.test(a.body)));

  // A road that never passes through the excusal paths: the hourly net.
  await prisma.deliverable.update({ where: { id: await reelOf(jD) }, data: { waivedAt: new Date(), waivedBy: "Kyle Drill", waivedNote: "by hand" } });
  c.ok("a hand edit alone leaves it open until the net runs", !(await prisma.project.findUniqueOrThrow({ where: { id: jD } })).debriefSubmittedAt);
  const net = await reconcileWrapUps();
  const pD = await prisma.project.findUniqueOrThrow({ where: { id: jD } });
  c.ok("the hourly net completes it", !!pD.debriefSubmittedAt && net.completed >= 1, JSON.stringify(net));
  const net2 = await reconcileWrapUps();
  c.ok("…and a second pass finds nothing more to do", net2.completed === 0, JSON.stringify(net2));

  await markDeliverableNotCompleted(await reelOf(jE), "Agent cancelled");
  const pE = await prisma.project.findUniqueOrThrow({ where: { id: jE } });
  c.ok("an excuse is never a submit: a job nobody wrapped up stays open", !pE.debriefSubmittedAt && !pE.photosHandoffAt);
  const j8Row = await prisma.project.findUniqueOrThrow({ where: { id: j8 } });
  c.ok("a job whose video is still owed is untouched by the net", !j8Row.debriefSubmittedAt);

  const card2 = await scoreQuarter({ memberId: harrisonTm.id, now: new Date() });
  const rel2 = card2.areas.find((a) => a.key === "reliability");
  const came2 = (rel2?.notes ?? []).find((t) => /came in after 8:00 AM/.test(t)) ?? "";
  const owed2 = (rel2?.notes ?? []).find((t) => /still not in/.test(t)) ?? "";
  c.ok("the KPI does not score any of the four excused videos late (still 1 came late, 2 still owed)",
    /^1 shoot counts/.test(came2) && /^2 shoots count/.test(owed2), `${came2} | ${owed2}`);
  const excusedRows = await prisma.project.findMany({ where: { id: { in: [jA, jB, jC, jD] } }, include: { deliverables: true } });
  c.ok("…because the clock, told what is live, owes nothing on them",
    excusedRows.every((r) => !videoHalfClock({ ...r, videoLive: liveHandoffCategories(r.deliverables).includes("video") })?.overdue));

  // =======================================================================
  c.head("11 · photos in after tonight's chaser: told right away, once");
  const SHOOT_MON = new Date("2026-09-28T10:00:00-04:00");
  setClock("2026-09-28T21:00:00-04:00"); // Mon 9 PM, before the 10 PM chaser
  const jEarly = await job("111 Early Eve Rd", { shootDate: SHOOT_MON });
  texts.length = 0;
  await finalizeUpload(jEarly, { ...PHOTO_ANSWERS, scope: "photos" });
  c.ok("before the chaser hour the submit texts nothing (tonight's chaser carries it)", texts.length === 0, JSON.stringify(texts));
  setClock("2026-09-28T22:00:00-04:00");
  await digest.sendNightlyUploadNags();
  c.ok("the 10 PM chaser names it with its own link", texts.length === 1 && texts[0].text.includes(`https://drill.invalid/upload/${jEarly}`), texts.map((t) => t.text).join(" || "));
  const early = await digest.sendSplitNoticeIfChaserPassed(jEarly);
  c.ok("…and the late-evening send will not tell it a second time", !early.sent && early.reason === "already told" && texts.length === 1, JSON.stringify(early));

  setClock("2026-09-28T22:30:00-04:00");
  const jLate = await job("112 Late Eve Rd", { shootDate: SHOOT_MON });
  texts.length = 0;
  const rLate = await finalizeUpload(jLate, { ...PHOTO_ANSWERS, scope: "photos" });
  c.ok("photos at 10:30 PM (after the chaser): the video is due 8:00 AM Tuesday", rLate.handoff?.videoDueISO === "2026-09-29T12:00:00.000Z", JSON.stringify(rLate.handoff));
  c.ok("…and the photographer is texted now, on his own phone", texts.length === 1 && texts[0].to === "+16105550142", JSON.stringify(texts));
  const lateBody = texts[0]?.text ?? "";
  c.ok("…in Jordan's words with this job's portal link",
    lateBody.includes("Photos are uploaded for 112 Late Eve Rd, but the video is not") && lateBody.includes("before 8:00 AM tomorrow") && lateBody.includes(`https://drill.invalid/upload/${jLate}`) && /late upload on your KPIs/.test(lateBody), lateBody);
  c.ok("…logged like the chaser's texts", (await prisma.commLog.count({ where: { externalId: `upload-split-${jLate}` } })) === 1);
  const again2 = await digest.sendSplitNoticeIfChaserPassed(jLate);
  c.ok("…once: a second call is a no-op", !again2.sent && texts.length === 1, JSON.stringify(again2));
  setClock("2026-09-29T22:00:00-04:00"); // Tue's chaser
  texts.length = 0;
  await digest.sendNightlyUploadNags();
  c.ok("the next night's chaser tells neither job again", !texts.some((t) => t.text.includes(jLate) || t.text.includes(jEarly)), texts.map((t) => t.text).join(" || "));

  const { putSetting, internalAlertRules } = await import("@/lib/settings");
  const rules = await internalAlertRules();
  await putSetting("internal_alerts", { ...rules, uploadChaser: { ...rules.uploadChaser, enabled: false } });
  setClock("2026-09-29T22:40:00-04:00");
  const jOff = await job("113 Switched Off St", { shootDate: new Date("2026-09-29T10:00:00-04:00") });
  texts.length = 0;
  await finalizeUpload(jOff, { ...PHOTO_ANSWERS, scope: "photos" });
  c.ok("with the chaser switched off, the late-evening send is silent too", texts.length === 0, JSON.stringify(texts));
  await putSetting("internal_alerts", rules);

  c.head("12 · nothing left the building");
  c.ok("every text was recorded at the boundary, none sent", fence.blocked.every((u) => !/openphone/i.test(u)));

  quiet.restore();
  fence.restore();
  try { fs.unlinkSync(path.join(base.dir, "node_modules")); fs.rmSync(base.dir, { recursive: true, force: true }); } catch { /* harmless */ }
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
