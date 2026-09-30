// ---------------------------------------------------------------------------
// DRILL: B4 UPLOADS — what the upload says is TRUE (§7.3), what it asks for
// follows the PRODUCT (§7.4), missing work is OWNED (§7.6), and field feedback
// is a PROPOSAL (§7.8). Unified handoff batch 4, Sep 25 2026.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//     NODE_OPTIONS=--conditions=react-server \
//     npx tsx --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/b4-uploads.ts
//
// OLD behaviour first, wherever it can be observed: the modules as they stood
// at fa9a2c9 (git show, `@/` imports aimed at this tree) run on twin rows.
//
//   1. §7.3 the evidence ladder (lib/handoff handoffEvidence): a fresh count is
//      evidence, a stale zero or an unreadable folder is UNKNOWN; each rung is
//      its own field. The portal's receipt sentence never claims files after
//      "Submit anyway". The delivery board: OLD read a photographer's tick over
//      a freshly EMPTY video folder as "the files are in"; NEW says "Upload
//      reported, video files not found" — and "can't confirm" on a stale read.
//   2. §7.4 one video step (pipeline.resolveVideoSpec): a canceled premium
//      line no longer makes the handoff demand a script the page never showed
//      (OLD did); a Settings-mapped premium without the regex words now owes
//      its script in readiness as the gate always demanded; a stamped full
//      video on a "Standard Reel" label is gated as the page shows it.
//   3. §7.6 missing work: one card per missing reel (OLD: two), one gap, never
//      a waiver; a reshoot needs its shot list and scope; the office's "Not
//      required" resolves the gap, a withdrawn reason cancels it; a missed
//      shot joins the one field-flag loop.
//   4. §7.8 field feedback: PROPOSED, off every brief until the office
//      confirms; confirmed client-wide it reaches every live job and rings one
//      bell per affected editor, once; project-scoped stays on its job.
//
// ISOLATION. PGlite on 127.0.0.1:5711 (DRILL_PORT overrides) through the shared
// harness; production is never opened. Every non-loopback call is fenced and
// counted (Slack, Aryeo, Stripe: none may leave). AUTH_ENFORCE is on.
//
// THE CLOCK is pinned to Friday Sep 25 2026, 14:00 ET.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5711);
const BASE = "fa9a2c9"; // the commit this batch starts from — never HEAD
const REPO = path.resolve(__dirname, "../..");

const RealDate = Date;
const SIM = RealDate.parse("2026-09-25T14:00:00-04:00");
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

installNextStubs();
const fence = fenceFetch();

function writeBaseCopies() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b4-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string, special: Record<string, string> = {}) =>
    src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${special[p] ?? path.join(REPO, "src", p)}${q}`);
  const handoff = path.join(dir, "handoff.base.ts");
  fs.writeFileSync(handoff, point(show("src/lib/handoff.ts")));
  const tasks = path.join(dir, "tasks.base.ts");
  fs.writeFileSync(tasks, point(show("src/lib/tasks.ts"), { "lib/handoff": handoff.replace(/\.ts$/, "") }));
  const board = path.join(dir, "deliveryBoard.base.ts");
  fs.writeFileSync(board, point(show("src/lib/deliveryBoard.ts")));
  const actions = path.join(dir, "uploadActions.base.ts");
  fs.writeFileSync(actions, point(show("src/app/upload/actions.ts")));
  return { dir, handoff, tasks, board, actions };
}

const c = makeChecker();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const handoff = await import("@/lib/handoff");
  const { resolveVideoSpec } = await import("@/lib/pipeline");
  const tasks = await import("@/lib/tasks");
  const { deliveryBoard } = await import("@/lib/deliveryBoard");
  const actions = await import("@/app/upload/actions");
  const { waiveDeliverable } = await import("@/app/projects/deliverableActions");
  const { productionFactsForProject, factsForPrompt } = await import("@/lib/clientFacts");
  const { establishSession, setSession } = await import("@/lib/auth/session");
  const { fieldFlagLoopKey } = await import("@/lib/fieldIssues");
  const base = writeBaseCopies();
  const oldTasks = (await import(base.tasks)) as { ensureEditorHandoff: (id: string) => Promise<void> };
  const oldBoard = (await import(base.board)) as { deliveryBoard: () => Promise<{ today: { id: string; blocker: string; blockerLabel: string }[]; tomorrow: { id: string; blocker: string; blockerLabel: string }[]; upcoming: { id: string; blocker: string; blockerLabel: string }[]; delivered: { id: string; blocker: string; blockerLabel: string }[] }> };
  const oldActions = (await import(base.actions)) as { finalizeUpload: (id: string, data: unknown) => Promise<Record<string, unknown>> };

  // ---- the world ---------------------------------------------------------
  const client = await prisma.client.create({ data: { name: "B4 Client TEST" }, select: { id: true } });
  const other = await prisma.client.create({ data: { name: "B4 Other TEST" }, select: { id: true } });
  const harrisonTm = await prisma.teamMember.create({ data: { name: "Harrison Drill", email: "harrison-b4@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-b4@drill.invalid", role: "ADMIN" } });
  const kimTm = await prisma.teamMember.create({ data: { name: "Kim Drill", email: "kim-b4@drill.invalid", role: "EDITOR" }, select: { id: true } });
  const harrison = await prisma.appUser.create({ data: { email: "harrison-b4@drill.invalid", name: "Harrison Drill", role: "PHOTOGRAPHER", status: "ACTIVE" }, select: { id: true } });
  const kyle = await prisma.appUser.create({ data: { email: "kyle-b4@drill.invalid", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" }, select: { id: true, email: true } });
  await prisma.appUser.create({ data: { email: "kim-b4@drill.invalid", name: "Kim Drill", role: "EDITOR", status: "ACTIVE", editorKey: "kim", teamMemberId: kimTm.id } });
  const owner = await prisma.appUser.create({ data: { email: "owner-b4@drill.invalid", name: "Jordan Drill", role: "OWNER", status: "ACTIVE" }, select: { id: true, email: true } });
  const asHarrison = () => establishSession(harrison.id);
  const asKyle = () => establishSession(kyle.id);
  const SHOT = new Date("2026-09-24T10:00:00-04:00");
  const fresh = (rawPhotos: number, rawVideo: number, stale = false) =>
    JSON.stringify({ expected: ["VIDEO"], present: [], missing: ["VIDEO"], dropbox: { rawPhotos, rawVideo, finalPhotos: 0, finalVideo: 0, ...(stale ? { stale: true } : {}) } });
  type Row = { type: "PHOTOS" | "VIDEO" | "SOCIAL_REEL"; label: string; videoStyle?: string; uploadedAt?: Date; status?: "PENDING" | "UPLOADED" };
  const job = async (street: string, rows: Row[], extra: Record<string, unknown> = {}, clientId = client.id) =>
    (await prisma.project.create({
      data: {
        title: `${street}, Emmaus, PA`, clientId, status: "SHOT", shootDate: SHOT, photographerId: harrisonTm.id,
        deliverables: { create: rows.map((r) => ({ type: r.type, label: r.label, quantity: 1, videoStyle: r.videoStyle ?? null, uploadedAt: r.uploadedAt ?? null, status: r.status ?? "PENDING" })) },
        ...extra,
      },
      select: { id: true },
    })).id;

  // =======================================================================
  c.head("1 · §7.3 received, found, handed off — each only if true");
  const t0 = new Date("2026-09-24T21:00:00-04:00");
  const ev = (statusEvidence: string | null, more: Record<string, unknown> = {}) =>
    handoff.handoffEvidence({
      deliverables: [{ type: "PHOTOS", uploadedAt: t0 }, { type: "VIDEO", uploadedAt: null }],
      statusEvidence,
      ...more,
    });
  const e1 = ev(fresh(212, 6));
  c.ok("a fresh count > 0 is found", e1.find((e) => e.category === "photos")?.filesDetected === "yes" && e1.find((e) => e.category === "video")?.filesDetected === "yes");
  c.ok("a fresh zero is NOT found", ev(fresh(0, 0)).every((e) => e.filesDetected === "no"));
  c.ok("a stale zero is unknown, never missing", ev(fresh(0, 0, true)).every((e) => e.filesDetected === "unknown"));
  c.ok("a stale count > 0 is still real evidence", ev(fresh(9, 2, true)).every((e) => e.filesDetected === "yes"));
  c.ok("no Dropbox read at all, or an unreadable blob, is unknown", ev(null).every((e) => e.filesDetected === "unknown") && ev("{not json").every((e) => e.filesDetected === "unknown"));
  const ladder = ev(fresh(212, 6), {
    photosHandoffAt: new Date("2026-09-24T21:10:00-04:00"), videoHandoffAt: null, debriefSubmittedAt: null,
    handoffBlockedReason: "Waiting on the wrap-up on the upload page from Harrison.", editingStartedAt: null, outputsSubmitted: 0,
  });
  const ph = ladder.find((e) => e.category === "photos")!;
  const vi = ladder.find((e) => e.category === "video")!;
  c.ok("upload REPORTED is the photographer's tick, and only where ticked", ph.uploadReported?.getTime() === t0.getTime() && vi.uploadReported === null);
  c.ok("handed off is each half's own stamp", !!ph.handoffSubmitted && vi.handoffSubmitted === null);
  c.ok("ready-to-edit is the handoff engine's verdict, blocked with its reason", !!vi.readyToEdit && "blocked" in vi.readyToEdit && ph.readyToEdit === null);
  c.ok("editing started and cuts handed in are never inferred", vi.editingStarted === null && vi.outputSubmitted === 0);
  const legacy = handoff.handoffEvidence({ deliverables: [{ type: "PHOTOS" }], statusEvidence: fresh(10, 0), debriefSubmittedAt: t0 });
  c.ok("a page submitted the old way reads its whole-page stamp as the half's handoff", legacy[0].handoffSubmitted?.getTime() === t0.getTime());
  c.ok("an excused half is not on the ladder at all", handoff.handoffEvidence({ deliverables: [{ type: "PHOTOS" }, { type: "VIDEO", notCompletedReason: "agent cancelled" }], statusEvidence: null }).map((e) => e.category).join() === "photos");
  c.ok("the receipt after 'Submit anyway' never claims the files", /office will check before editing/.test(handoff.receiptSentence([{ filesDetected: "yes" }], true)));
  c.ok("the receipt with an empty folder says so", /did not show every file/.test(handoff.receiptSentence([{ filesDetected: "yes" }, { filesDetected: "no" }], false)));
  c.ok("the recorded file evidence does not pretend to be a fresh read", /last recorded Dropbox check showed files/.test(handoff.receiptSentence([{ filesDetected: "yes" }, { filesDetected: "yes" }], false)));
  c.ok("the receipt that could not look says it could not look", /no confirmed file count/.test(handoff.receiptSentence([{ filesDetected: "unknown" }], false)));
  const lineText = handoff.evidenceLine(vi, () => "t");
  c.ok("the one-line ladder names only what is true", lineText === "Video: no upload reported · files found in Dropbox (6) · not handed off yet · not ready to edit", lineText);

  // The board: a tick over a freshly empty video folder.
  const tickEmpty = await job("1 Tick Ln", [{ type: "VIDEO", label: "Listing Video", status: "UPLOADED", uploadedAt: t0 }], { statusEvidence: fresh(0, 0) });
  const tickStale = await job("2 Stale Ln", [{ type: "VIDEO", label: "Listing Video", status: "UPLOADED", uploadedAt: t0 }], { statusEvidence: fresh(0, 0, true) });
  const tickNever = await job("3 Never Ln", [{ type: "VIDEO", label: "Listing Video", status: "UPLOADED", uploadedAt: t0 }]);
  const tickFound = await job("4 Found Ln", [{ type: "VIDEO", label: "Listing Video", status: "UPLOADED", uploadedAt: t0 }], { statusEvidence: fresh(0, 7) });
  type J = { id: string; blocker: string; blockerLabel: string };
  const find = (b: { today: J[]; tomorrow: J[]; upcoming: J[]; delivered: J[] }, id: string) => [...b.today, ...b.tomorrow, ...b.upcoming, ...b.delivered].find((j) => j.id === id);
  const oldB = await oldBoard.deliveryBoard();
  const newB = await deliveryBoard();
  const oldTick = find(oldB, tickEmpty);
  c.ok("OLD: a tick over a freshly empty folder read as the files being in", !!oldTick && oldTick.blocker !== "awaiting_upload", `${oldTick?.blocker}: ${oldTick?.blockerLabel}`);
  const newTick = find(newB, tickEmpty);
  c.ok("NEW: 'Upload reported, video files not found'", newTick?.blocker === "awaiting_upload" && newTick.blockerLabel === "Upload reported, video files not found", `${newTick?.blocker}: ${newTick?.blockerLabel}`);
  const newStale = find(newB, tickStale);
  c.ok("NEW: a stale zero reads 'can't confirm', not missing", newStale?.blockerLabel === "Can't confirm the video files (Dropbox unreadable)", newStale?.blockerLabel);
  c.ok("a job Dropbox was never read for keeps the tick, exactly as before", find(newB, tickNever)?.blocker === find(oldB, tickNever)?.blocker, `${find(newB, tickNever)?.blocker}`);
  c.ok("a tick WITH files found is unchanged", find(newB, tickFound)?.blocker === find(oldB, tickFound)?.blocker && find(newB, tickFound)?.blocker !== "awaiting_upload", `${find(newB, tickFound)?.blocker}`);

  // =======================================================================
  c.head("2 · §7.4 one video step: page, gate, handoff and brief ask the same function");
  // A: a canceled premium line over a reel stamped standard.
  const canceled = await job("21 Canceled Premium Rd", [{ type: "SOCIAL_REEL", label: "Social Reel", videoStyle: "standard_reel" }], {
    statusEvidence: fresh(0, 5),
    orderItems: { create: [{ title: "Premium Social Media Reel", isCanceled: true }, { title: "Standard Social Media Reel" }] },
  });
  const canceledTwin = await job("22 Canceled Premium Twin", [{ type: "SOCIAL_REEL", label: "Social Reel", videoStyle: "standard_reel" }], {
    statusEvidence: fresh(0, 5),
    orderItems: { create: [{ title: "Premium Social Media Reel", isCanceled: true }, { title: "Standard Social Media Reel" }] },
  });
  const rA = resolveVideoSpec({ deliverables: [{ type: "SOCIAL_REEL", label: "Social Reel", videoStyle: "standard_reel" }], orderItems: [{ title: "Premium Social Media Reel", isCanceled: true }, { title: "Standard Social Media Reel" }], packageName: null });
  c.ok("resolveVideoSpec: the stamp wins, canceled lines are out → a plain reel", rA.source === "stamp" && rA.spec.minimalReel && !rA.spec.requireScript);
  await oldTasks.ensureEditorHandoff(canceledTwin).catch((e) => console.log("old handoff:", (e as Error).message));
  await tasks.ensureEditorHandoff(canceled).catch((e) => console.log("new handoff:", (e as Error).message));
  const blockOld = (await prisma.project.findUniqueOrThrow({ where: { id: canceledTwin }, select: { handoffBlockedReason: true } })).handoffBlockedReason ?? "";
  const blockNew = (await prisma.project.findUniqueOrThrow({ where: { id: canceled }, select: { handoffBlockedReason: true, handoffReadyAt: true } }));
  c.ok("OLD: the handoff demanded a script for the canceled premium line", /script/i.test(blockOld), blockOld);
  c.ok("NEW: nothing is demanded of the plain reel the page showed", !blockNew.handoffBlockedReason && !!blockNew.handoffReadyAt, blockNew.handoffBlockedReason ?? "ready");

  // B: a product Settings maps premium, with none of the premium name words.
  const mapped = await job("23 Mapped Premium Ave", [{ type: "VIDEO", label: "Premium Video" }], {
    statusEvidence: fresh(0, 5), videoInstructions: "EDITING NOTES\nlead with the view", debriefSubmittedAt: t0,
    orderItems: { create: [{ title: "DIAMOND BUNDLE" }] },
  });
  const mappedTwin = await job("24 Mapped Premium Twin", [{ type: "VIDEO", label: "Premium Video" }], {
    statusEvidence: fresh(0, 5), videoInstructions: "EDITING NOTES\nlead with the view", debriefSubmittedAt: t0,
    orderItems: { create: [{ title: "DIAMOND BUNDLE" }] },
  });
  await oldTasks.ensureEditorHandoff(mappedTwin).catch(() => {});
  await tasks.ensureEditorHandoff(mapped).catch(() => {});
  const mOld = (await prisma.project.findUniqueOrThrow({ where: { id: mappedTwin }, select: { handoffBlockedReason: true } })).handoffBlockedReason ?? "";
  const mNew = (await prisma.project.findUniqueOrThrow({ where: { id: mapped }, select: { handoffBlockedReason: true } })).handoffBlockedReason ?? "";
  c.ok("OLD: readiness ignored the Settings premium mapping (no script asked)", !/script/i.test(mOld), mOld || "ready");
  c.ok("NEW: readiness owes the premium script, as the gate always demanded", /script for this premium video/.test(mNew), mNew);
  await asHarrison();
  const mappedGate = await job("25 Mapped Gate Ave", [{ type: "VIDEO", label: "Premium Video" }], { status: "SCHEDULED", orderItems: { create: [{ title: "DIAMOND BUNDLE" }] } });
  const gateB = await actions.finalizeUpload(mappedGate, { editorBrief: "", force: true, videoInstructions: "VISION FOR THE EDIT\nslow and warm", providedScript: null });
  c.ok("…and the gate still refuses the premium submit without it", typeof gateB.blocked === "string" && /script/i.test(gateB.blocked), gateB.blocked);

  // C: a full video stamped on a "Standard Reel" label.
  const stampedOld = await job("26 Stamped Old Ct", [{ type: "SOCIAL_REEL", label: "Standard Reel", videoStyle: "standard_cinematic" }], { status: "SCHEDULED" });
  const stampedNew = await job("27 Stamped New Ct", [{ type: "SOCIAL_REEL", label: "Standard Reel", videoStyle: "standard_cinematic" }], { status: "SCHEDULED" });
  const gOld = await oldActions.finalizeUpload(stampedOld, { editorBrief: "", force: true });
  const gNew = await actions.finalizeUpload(stampedNew, { editorBrief: "", force: true });
  c.ok("OLD: the name-only gate let a stamped full video through with no instructions (the page demanded them)", !gOld.blocked, String(gOld.blocked));
  c.ok("NEW: the gate asks what the page asked", typeof gNew.blocked === "string" && /instructions/i.test(gNew.blocked), gNew.blocked);

  // =======================================================================
  c.head("3 · §7.6 missing work is owned, never silently dropped");
  const gapJob = await job("31 Gap Way", [{ type: "PHOTOS", label: "Photos" }, { type: "SOCIAL_REEL", label: "Social Reel", videoStyle: "standard_reel" }], { statusEvidence: fresh(30, 0) });
  const gapTwin = await job("32 Gap Twin", [{ type: "PHOTOS", label: "Photos" }, { type: "SOCIAL_REEL", label: "Social Reel", videoStyle: "standard_reel" }], { statusEvidence: fresh(30, 0) });
  const reel = await prisma.deliverable.findFirstOrThrow({ where: { projectId: gapJob, type: "SOCIAL_REEL" }, select: { id: true } });
  const reelTwin = await prisma.deliverable.findFirstOrThrow({ where: { projectId: gapTwin, type: "SOCIAL_REEL" }, select: { id: true } });
  // OLD: the reason + the old handoff pass → two cards for one reel.
  await prisma.deliverable.update({ where: { id: reelTwin.id }, data: { notCompletedReason: "Agent cancelled the reel on site", notCompletedAt: new Date() } });
  await tasks.confirmNotRequiredTask(reelTwin.id);
  await oldTasks.ensureEditorHandoff(gapTwin).catch(() => {});
  const cardsFor = (projectId: string) => prisma.smartTask.findMany({
    where: { projectId, status: { notIn: ["CANCELLED"] }, OR: [{ title: { startsWith: "Confirm: " } }, { title: { startsWith: "Video marked not completable" } }] },
    select: { title: true, status: true, dedupeKey: true },
  });
  c.ok("OLD: two cards for one missing reel", (await cardsFor(gapTwin)).length === 2, (await cardsFor(gapTwin)).map((t) => t.title).join(" | "));
  await asHarrison();
  await actions.markDeliverableNotCompleted(reel.id, "Agent cancelled the reel on site");
  await tasks.ensureEditorHandoff(gapJob).catch(() => {});
  const cards = await cardsFor(gapJob);
  c.ok("NEW: exactly one card — the office's 'not required?' question", cards.length === 1 && cards[0].title.startsWith("Confirm: "), cards.map((t) => t.title).join(" | "));
  const gaps = await prisma.productionGap.findMany({ where: { projectId: gapJob } });
  c.ok("one OPEN output gap: what, why, who", gaps.length === 1 && gaps[0].state === "OPEN" && gaps[0].kind === "OUTPUT" && gaps[0].deliverableId === reel.id && gaps[0].reason === "Agent cancelled the reel on site" && gaps[0].raisedBy === "Harrison Drill");
  c.ok("…linked to the office's card", !!gaps[0].taskId);
  c.ok("never a waiver", (await prisma.deliverable.findUniqueOrThrow({ where: { id: reel.id } })).waivedAt === null);
  await actions.markDeliverableNotCompleted(reel.id, "Agent cancelled the reel on site; will rebook");
  c.ok("a re-worded reason updates the one gap, never a second", (await prisma.productionGap.count({ where: { projectId: gapJob } })) === 1 && (await prisma.productionGap.findFirstOrThrow({ where: { projectId: gapJob } })).reason.endsWith("will rebook"));

  const gapId = gaps[0].id;
  const refused = await actions.planGapRecovery(gapId, { recovery: "RESHOOT", ownerKey: "harrison", dueDay: "2026-09-29", shotList: [], scopeNote: "reel only" });
  c.ok("a photographer cannot plan the recovery (office only)", !refused.ok, refused.message);
  await asKyle();
  const noList = await actions.planGapRecovery(gapId, { recovery: "RESHOOT", ownerKey: "harrison", dueDay: "2026-09-29", shotList: [], scopeNote: "reel only" });
  c.ok("a reshoot with no shot list is refused", !noList.ok && /shot list/i.test(noList.message), noList.message);
  const noScope = await actions.planGapRecovery(gapId, { recovery: "RESHOOT", ownerKey: "harrison", dueDay: "2026-09-29", shotList: [{ shot: "Kitchen reveal" }], scopeNote: "" });
  c.ok("a reshoot with no scope is refused", !noScope.ok && /scope/i.test(noScope.message), noScope.message);
  const blockedBefore = fence.blocked.length;
  const planned = await actions.planGapRecovery(gapId, { recovery: "RESHOOT", ownerKey: "Harrison", dueDay: "2026-09-29", shotList: [{ shot: "Kitchen reveal" }, { shot: "Pool at dusk" }], scopeNote: "The reel only; photos stand" });
  const g2 = await prisma.productionGap.findUniqueOrThrow({ where: { id: gapId } });
  c.ok("with its list and scope it is PLANNED: owner, date, shots", planned.ok && g2.state === "PLANNED" && g2.ownerKey === "harrison" && g2.dueAt?.toISOString() === "2026-09-29T21:00:00.000Z" && JSON.parse(g2.shotListJson ?? "[]").length === 2);
  c.ok("nothing is booked or charged: no provider call, no waiver", fence.blocked.length === blockedBefore && (await prisma.deliverable.findUniqueOrThrow({ where: { id: reel.id } })).waivedAt === null);
  c.ok("the plan is on the timeline", (await prisma.activity.count({ where: { projectId: gapJob, body: { startsWith: "Recovery planned for" } } })) === 1);
  const waived = await waiveDeliverable(reel.id, "Client dropped the reel from the order");
  const g3 = await prisma.productionGap.findUniqueOrThrow({ where: { id: gapId } });
  c.ok("the office's 'Not required' RESOLVES the gap with its note", waived.ok && g3.state === "RESOLVED" && g3.resolutionNote === "Marked not required: Client dropped the reel from the order" && g3.resolvedBy === "Kyle Drill", `${g3.state} ${g3.resolutionNote}`);

  // A withdrawn reason cancels the gap and the card.
  const wJob = await job("33 Withdraw St", [{ type: "PHOTOS", label: "Photos" }, { type: "SOCIAL_REEL", label: "Social Reel" }]);
  const wReel = await prisma.deliverable.findFirstOrThrow({ where: { projectId: wJob, type: "SOCIAL_REEL" }, select: { id: true } });
  await asHarrison();
  await actions.markDeliverableNotCompleted(wReel.id, "Seller asked us to skip it");
  await actions.markDeliverableNotCompleted(wReel.id, "");
  const wg = await prisma.productionGap.findFirstOrThrow({ where: { projectId: wJob } });
  const wCard = await prisma.smartTask.findFirst({ where: { projectId: wJob, title: { startsWith: "Confirm: " } }, select: { status: true } });
  c.ok("a withdrawn reason CANCELS the gap (kept, with why)", wg.state === "CANCELLED" && wg.resolutionNote === "The photographer withdrew the reason.");
  c.ok("…and the office's card", wCard?.status === "CANCELLED");

  // The footage turned up after all: the TICK clears the reason (review, Sep
  // 25). It used to leave the gap OPEN at the top of the office's list, and
  // the card open, for a reel that was now marked uploaded — syncOutputGap's
  // "Marked uploaded after all." branch could never run.
  const tJob = await job("35 Found It Ln", [{ type: "PHOTOS", label: "Photos" }, { type: "SOCIAL_REEL", label: "Social Reel" }]);
  const tReel = await prisma.deliverable.findFirstOrThrow({ where: { projectId: tJob, type: "SOCIAL_REEL" }, select: { id: true } });
  await actions.markDeliverableNotCompleted(tReel.id, "Card error, footage lost");
  c.ok("(the reason raised an OPEN gap and the office's card)",
    (await prisma.productionGap.findFirstOrThrow({ where: { projectId: tJob } })).state === "OPEN" &&
      (await prisma.smartTask.findFirst({ where: { projectId: tJob, title: { startsWith: "Confirm: " } }, select: { status: true } }))?.status === "OPEN");
  await actions.markDeliverableUploaded(tReel.id, true);
  const tg = await prisma.productionGap.findFirstOrThrow({ where: { projectId: tJob } });
  const tCard = await prisma.smartTask.findFirst({ where: { projectId: tJob, title: { startsWith: "Confirm: " } }, select: { status: true } });
  c.ok("ticked uploaded after 'couldn't complete': the gap is CANCELLED, 'Marked uploaded after all.'", tg.state === "CANCELLED" && tg.resolutionNote === "Marked uploaded after all.", `${tg.state} ${tg.resolutionNote}`);
  c.ok("…and the office's card with it", tCard?.status === "CANCELLED", tCard?.status);

  // A missed shot: a gap + the job's ONE field-flag loop.
  const sJob = await job("34 Shot St", [{ type: "PHOTOS", label: "Photos" }]);
  const s1 = await actions.reportMissedShot(sJob, { what: "Pool at dusk", reason: "Rain rolled in before sunset" });
  const s2 = await actions.reportMissedShot(sJob, { what: "Pool at dusk", reason: "Rain rolled in before sunset" });
  const s3 = await actions.reportMissedShot(sJob, { what: "Basement", reason: "Locked" });
  const loops = await prisma.smartTask.count({ where: { projectId: sJob, dedupeKey: fieldFlagLoopKey(sJob) } });
  c.ok("a missed shot is logged; the same one twice is 'already logged'", s1.ok && s2.ok && /Already/.test(s2.message) && s3.ok);
  c.ok("two SHOT gaps, one FLAG each, ONE field-flag loop for the job",
    (await prisma.productionGap.count({ where: { projectId: sJob, kind: "SHOT" } })) === 2 &&
      (await prisma.activity.count({ where: { projectId: sJob, type: "FLAG", body: { startsWith: "Missed shot:" } } })) === 2 && loops === 1, `loops ${loops}`);
  const blank = await actions.reportMissedShot(sJob, { what: "Front door", reason: "" });
  c.ok("a missed shot needs its reason", !blank.ok);

  // =======================================================================
  c.head("4 · §7.8 field feedback is a proposal until the office confirms it");
  const oldFacts = execFileSync("git", ["show", `${BASE}:src/lib/clientFacts.ts`], { cwd: REPO, encoding: "utf8" });
  c.ok("OLD: a client fact could not even say it came from the field", !/"field"/.test(oldFacts.match(/source: [^;]+;/)?.[0] ?? ""));
  const f1 = await job("41 Field Rd", [{ type: "PHOTOS", label: "Photos" }, { type: "SOCIAL_REEL", label: "Social Reel" }]);
  const f2 = await job("42 Field Rd", [{ type: "SOCIAL_REEL", label: "Social Reel" }], { status: "EDITING" });
  const fOther = await job("43 Elsewhere Rd", [{ type: "SOCIAL_REEL", label: "Social Reel" }], { status: "EDITING" }, other.id);
  await prisma.smartTask.create({ data: { taskType: "edit_video", title: "Edit 42 Field Rd", source: "system", projectId: f2, assignedKey: "kim", dedupeKey: "drill-edit-f2" } });
  await asHarrison();
  const obs = await actions.recordFieldPreference(f1, { body: "They probably prefer a serif font", basis: "observation", scope: "client" });
  const said = await actions.recordFieldPreference(f1, { body: "Wants the logo bottom-right on this listing", basis: "client_said", scope: "project" });
  const facts = await prisma.clientFact.findMany({ where: { clientId: client.id, source: "field" }, orderBy: { createdAt: "asc" } });
  c.ok("both are recorded", obs.ok && said.ok && facts.length === 2, `${obs.message} / ${said.message}`);
  c.ok("…as PROPOSED, never auto-accepted, out of AI context", facts.every((f) => f.status === "PROPOSED" && !f.autoAccepted && f.aiContext === "DENIED"));
  c.ok("the basis and the job ride on sourceRef", facts[0].sourceRef === `field:${f1}:observation` && facts[1].sourceRef === `field:${f1}:client_said`);
  c.ok("scope: client-wide vs this job", facts[0].scope === "PERMANENT" && facts[1].scope === "PROJECT" && facts[1].projectId === f1);
  c.ok("a proposal reaches no editor brief", (await productionFactsForProject(client.id, f1)).length === 0 && (await factsForPrompt(client.id, { projectId: f1 })).length === 0);
  const dup = await actions.recordFieldPreference(f1, { body: "They probably prefer a serif font", basis: "observation", scope: "client" });
  c.ok("the same words again are 'already on file'", dup.ok && /Already/.test(dup.message) && (await prisma.clientFact.count({ where: { clientId: client.id, source: "field" } })) === 2);
  await setSession({ uid: owner.id, email: owner.email, role: "OWNER", actingAs: harrison.id });
  const peek = await actions.recordFieldPreference(f1, { body: "preview write", basis: "observation", scope: "project" });
  c.ok("an owner's 'view as' preview cannot record one", !peek.ok);
  await asHarrison();
  const selfConfirm = await actions.decideFieldReport(facts[0].id, "ACCEPT");
  c.ok("a photographer cannot confirm their own report", !selfConfirm.ok);

  await asKyle();
  const acc = await actions.decideFieldReport(facts[0].id, "ACCEPT");
  c.ok("the office confirms the client-wide one", acc.ok, acc.message);
  const onF1 = await productionFactsForProject(client.id, f1);
  const onF2 = await productionFactsForProject(client.id, f2);
  const onOther = await productionFactsForProject(other.id, fOther);
  c.ok("…it is on every live job's brief for that client, and no other client's", onF1.some((l) => l.includes("serif")) && onF2.some((l) => l.includes("serif")) && onOther.length === 0);
  const bells = await prisma.notification.findMany({ where: { kind: "field_preference" }, select: { userKey: true, dedupeKey: true } });
  // Who holds an open edit on this client's live jobs: Kim on 42 Field Rd, and
  // whoever the handoff engine routed the earlier jobs in this drill to.
  const holders = [...new Set((await prisma.smartTask.findMany({
    where: { project: { clientId: client.id, status: { in: ["SHOT", "EDITING", "REVIEW", "REVISION"] } }, taskType: { in: ["edit_video", "revision"] }, status: { notIn: ["COMPLETED", "CANCELLED"] }, assignedKey: { not: null } },
    select: { assignedKey: true },
  })).map((t) => `editor:${t.assignedKey}`))].sort();
  c.ok("one bell per editor holding that client's open edits — no more, no fewer", JSON.stringify(bells.map((b) => b.userKey).sort()) === JSON.stringify(holders) && holders.includes("editor:kim"), `${JSON.stringify(bells.map((b) => b.userKey))} vs ${JSON.stringify(holders)}`);
  c.ok("no editor of another client hears it", !bells.some((b) => b.dedupeKey?.includes(fOther)));
  const legs = await prisma.notificationDelivery.findMany({ where: { kind: "field_preference" }, select: { channel: true, status: true } });
  c.ok("the bell is the only channel (no text or Slack leg was sent)", legs.every((l) => l.channel === "bell" || l.status !== "sent"), JSON.stringify(legs));
  c.ok("a timeline line on the live job it changes", (await prisma.activity.count({ where: { projectId: f2, body: { startsWith: "Client preference confirmed" } } })) === 1);
  await actions.decideFieldReport(facts[0].id, "ACCEPT");
  c.ok("confirming again rings nothing new", (await prisma.notification.count({ where: { kind: "field_preference" } })) === bells.length);
  await actions.decideFieldReport(facts[1].id, "ACCEPT");
  c.ok("the project-scoped one reaches its own job only", (await productionFactsForProject(client.id, f1)).some((l) => l.includes("bottom-right")) && !(await productionFactsForProject(client.id, f2)).some((l) => l.includes("bottom-right")));
  const rej = await prisma.clientFact.create({ data: { clientId: client.id, category: "PRODUCTION_PREFERENCE", body: "Hates drone shots", source: "field", sourceRef: `field:${f1}:observation`, scope: "PERMANENT", status: "PROPOSED", visibility: "INTERNAL", aiContext: "DENIED", dedupeHash: "drill-rej" }, select: { id: true } });
  await actions.decideFieldReport(rej.id, "REJECT");
  c.ok("a rejected report stays off every brief (kept as history)", !(await productionFactsForProject(client.id, f2)).some((l) => l.includes("drone")) && (await prisma.clientFact.findUniqueOrThrow({ where: { id: rej.id } })).status === "REJECTED");

  c.head("5 · nothing left the building");
  c.ok("no Aryeo, Stripe or OpenPhone call was attempted", !fence.blocked.some((u) => /aryeo|stripe|openphone/i.test(u)), fence.blocked.filter((u) => /aryeo|stripe|openphone/i.test(u)).slice(0, 3).join(", "));

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
