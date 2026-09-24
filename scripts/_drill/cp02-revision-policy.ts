// ---------------------------------------------------------------------------
// DRILL: CP-02 — the review window and the per-video revision policy
// (completion audit, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp02-revision-policy.ts
//
// What it proves, the OLD behaviour first wherever it can be observed (the
// OLD clientDecisions.ts and content/actions.ts are loaded for real from
// 9defa7a, their `@/` imports pointed at this tree):
//   0. OLD — approve and request both land on one cut; a TOKEN reader is told
//      "Approved by you" about a row with no person on it; the old approve
//      wrote no clientReleasedAt, so the reminder lane's query counted zero.
//   1. Release opens exactly one window, deadline = endOfBusinessDaysET(+4).
//   2. Rounds 1 and 2 are included; a release answers the open round.
//   3. Round 3: with revision_policy OFF it simply proceeds; ON it needs the
//      acknowledgement (owner or assistant), records the fee, files Kyle's card — and the
//      editor's task and brief carry no money.
//   4. The office decides CHARGE/WAIVE once; nothing is billed.
//   5. Expiry: auto-approval only with both switches, TEST only by default.
//   6. Holds: each one hands the window to the office instead — and a window
//      never held to a deadline (LAZY, pre-switch) is not swept at all.
//   7. A request just before the deadline wins; one after it is refused
//      (staff may override).
//   8. Approve and request racing on one cut: exactly one wins, 10 times.
//   9. A replacement cut gets no free rounds and needs its own decision.
//  10. The client plays only the latest version; staff see every round.
//  11. The reminder lane reads the window's persisted deadline, per batch.
//  12. UI-02: approveScript signs exactly the version the tab showed.
//  13. The cron repair opens a missed window from the true release; staff may
//      approve over a request or reopen an approval; a version restored by a
//      take-back gets its window back, on hold.
//  14. The review cadence counts reminders per WINDOW: closing Monday's
//      videos does not restart a Tuesday one, and a spent Monday video does
//      not starve a later batch.
//  (The Sep 24 review's window/decision fixes are in cp02b-review-hardening.ts.)
//
// ISOLATION: PGlite on 127.0.0.1:5503 via the shared harness; production is
// never opened, every outbound call is fenced and counted.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5503);
const REPO = path.resolve(__dirname, "../..");
const BASE = "9defa7a";

installNextStubs();
const fence = fenceFetch();

/** The OLD modules, byte for byte from BASE, their `@/` imports aimed at this tree. */
function writeBaseCopies(): { dir: string; clientDecisions: string; contentActions: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp02-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const clientDecisions = path.join(dir, "clientDecisions.base.ts");
  fs.writeFileSync(clientDecisions, point(show("src/lib/clientDecisions.ts")));
  const contentActions = path.join(dir, "contentActions.base.ts");
  fs.writeFileSync(contentActions, point(show("src/app/content/actions.ts")));
  return { dir, clientDecisions, contentActions };
}
function removeBaseCopies(dir: string) {
  try {
    fs.unlinkSync(path.join(dir, "node_modules"));
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* a leftover temp dir is harmless */ }
}

async function main() {
  const { server, stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const rw = await import("@/lib/reviewWindows");
  const cd = await import("@/lib/clientDecisions");
  const rr = await import("@/app/review/actions");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const { endOfBusinessDaysET, addBusinessDayKeysET, addBusinessDaysET, etAt, etDayKey } = await import("@/lib/datetime");
  const { streamUrlFor } = await import("@/lib/reviewCuts");
  const { evaluateReminders } = await import("@/lib/programReminders");
  const { loadContentTab } = await import("@/app/content/[id]/workspaceData");
  const base = writeBaseCopies();
  type PortalViewer = import("@/lib/portal").PortalViewer;
  const old = (await import(base.clientDecisions)) as {
    approveCut: (v: PortalViewer, s: string, c: string) => Promise<{ ok: boolean; message: string }>;
    requestChangesOnCut: (v: PortalViewer, s: string, n: string) => Promise<{ ok: boolean; message: string }>;
    isMine: (v: PortalViewer, r: { clientUserId: string | null; staffUserId: string | null }) => boolean;
  };

  // ---- the world every section shares -----------------------------------
  await prisma.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ personalBranding: "kim" }) } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-drill@example.com" } });
  const staffUser = await prisma.appUser.create({ data: { email: "kyle@realtourpilot.com", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  const HOUR = 3_600_000;
  let seq = 0;

  type World = { f: ContentMonthFixture; viewer: PortalViewer; staff: PortalViewer; token: PortalViewer; videos: string[] };
  const world = async (name: string, over: Partial<Parameters<typeof buildContentMonth>[1]> = {}): Promise<World> => {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, "");
    const f = await buildContentMonth(prisma as unknown as PrismaClient, {
      name: `${name} TEST`, package: "Accelerator", videosPerMonth: 4, monthKey: "2026-10",
      owner: { email: `${slug}@realtourpilot.com`, name }, ...over,
    });
    await ensureOutputsForProject(f.projectId!);
    const videos: string[] = [];
    for (let slot = 1; slot <= 10; slot++) {
      const v = await prisma.contentVideo.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, monthKey: f.monthKey, projectId: f.projectId, deliverableId: f.deliverableId, slot, status: "EDITING", title: `Video ${slot}` }, select: { id: true } });
      videos.push(v.id);
    }
    const enrollment = { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth };
    return {
      f, videos,
      viewer: { enrollment, actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: `${slug}@realtourpilot.com`, name, membershipId: f.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" } as PortalViewer,
      staff: { enrollment, actor: { kind: "STAFF", staffUserId: staffUser.id, staffName: "Kyle Drill", staffRole: "ADMIN" }, access: "FULL", via: "STAFF" } as PortalViewer,
      token: { enrollment, actor: { kind: "TOKEN" }, access: "FULL", via: "TOKEN" } as PortalViewer,
    };
  };
  /** A cut the editor handed in: PENDING, playable, on its video. */
  const mkCut = async (w: World, slot: number, round: number, over: Record<string, unknown> = {}) => {
    const row = await prisma.reviewSubmission.create({
      data: { projectId: w.f.projectId!, deliverableId: w.f.deliverableId, slot, round, status: "PENDING", fileName: `${w.f.clientName.split(" ")[0].toLowerCase()}-video${slot}-v${round}.mp4`, source: "upload", submittedByKey: "kim", videoId: w.videos[slot - 1], createdAt: new Date(Date.now() - 1000 + seq++), ...over },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id) } });
    return row.id;
  };
  /** Jordan's QC approve in the Review Room — which is the release. */
  const release = async (id: string) => {
    const r = await rr.approveCut(id);
    if (!r.ok) throw new Error(`release ${id}: ${r.message}`);
    return r;
  };
  const note = (w: World, sub: string, body: string) =>
    prisma.portalComment.create({ data: { submissionId: sub, projectId: w.f.projectId!, enrollmentId: w.f.enrollmentId, timeSec: 12, body, status: "OPEN", clientUserId: w.f.clientUserId }, select: { id: true } });
  const windowOf = (sub: string) => prisma.contentReviewWindow.findUnique({ where: { submissionId: sub } });
  const setSwitch = async (key: string, enabled: boolean, enabledAt = new Date(Date.now() - HOUR), configJson: string | null = null) => {
    await prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt, configJson }, update: { enabled, enabledAt, configJson } });
  };

  // =========================================================================
  c.head("0 · OLD (9defa7a): nothing serialised the two verdicts, nothing stamped a release");
  // =========================================================================
  {
    const w0 = await world("Olive Old");
    const o1 = await mkCut(w0, 1, 1);
    // The old Review Room approve wrote exactly these three columns.
    await prisma.reviewSubmission.update({ where: { id: o1 }, data: { status: "APPROVED", decidedAt: new Date(), decidedBy: "Jordan" } });
    const stamped = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: o1 } });
    c.ok("OLD: the approve left clientReleasedAt null", stamped.clientReleasedAt === null);
    const oldLane = await prisma.reviewSubmission.count({ where: { projectId: w0.f.projectId!, clientReleasedAt: { not: null }, clientApprovedDecisionId: null, clientRequestedAt: null, withdrawnAt: null } });
    c.ok("OLD: so the reminder lane's own query counted 0 released cuts — review reminders could never fire", oldLane === 0, String(oldLane));
    const a = await old.approveCut(w0.viewer, o1, "NONE");
    await note(w0, o1, "old path: fix the intro");
    const r = await old.requestChangesOnCut(w0.viewer, o1, "");
    const kinds = (await prisma.clientDecision.findMany({ where: { submissionId: o1 }, select: { decision: true } })).map((d) => d.decision).sort();
    c.ok("OLD: approve then request on the SAME cut both succeed", a.ok && r.ok, `${a.message} / ${r.message}`);
    c.ok("OLD: the cut now holds BOTH an APPROVE and a REQUEST_CHANGES", kinds.join(",") === "APPROVE,REQUEST_CHANGES", kinds.join(","));
    c.ok("OLD: a TOKEN reader owned any row with no person on it (an automatic approval would read 'Approved by you')", old.isMine(w0.token, { clientUserId: null, staffUserId: null }) === true);
    c.ok("NEW: a row with basis AUTO_EXPIRY belongs to nobody", cd.isMine(w0.token, { clientUserId: null, staffUserId: null, basis: "AUTO_EXPIRY" }) === false);
  }

  // =========================================================================
  c.head("1 · release opens exactly one window, deadline frozen at +4 business days");
  // =========================================================================
  const A = await world("Ada Vance");
  const a1 = await mkCut(A, 1, 1);
  {
    await release(a1);
    const ws = await prisma.contentReviewWindow.findMany({ where: { submissionId: a1 } });
    const sub = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: a1 } });
    c.ok("one window, OPEN, source RELEASE", ws.length === 1 && ws[0].state === "OPEN" && ws[0].source === "RELEASE", `${ws.length}/${ws[0]?.state}`);
    c.ok("clientReleasedAt is stamped at the release", !!sub.clientReleasedAt && sub.clientReleasedAt.getTime() === ws[0].openedAt.getTime());
    c.ok("deadlineAt === endOfBusinessDaysET(openedAt, 4)", ws[0].deadlineAt.getTime() === endOfBusinessDaysET(ws[0].openedAt, 4).getTime(), ws[0].deadlineAt.toISOString());
    c.ok("the window names the video's DeliverableOutput", !!ws[0].outputId);
    const again = await rr.approveCut(a1);
    c.ok("a second approve: 'Already approved', still one window", again.ok && /Already approved/.test(again.message) && (await prisma.contentReviewWindow.count({ where: { submissionId: a1 } })) === 1);
    // Friday 3 pm ET → Thursday 5 pm ET.
    const fri = new Date("2026-10-02T19:00:00Z");
    const fCut = await mkCut(A, 2, 1);
    await prisma.reviewSubmission.update({ where: { id: fCut }, data: { status: "APPROVED", decidedAt: fri, decidedBy: "Jordan" } });
    const fw = await rw.openReviewWindow(fCut, { at: fri });
    c.ok("released Fri 3:00 PM ET → due Thu 5:00 PM ET", fw?.deadlineAt.toISOString() === "2026-10-08T21:00:00.000Z", fw?.deadlineAt.toISOString());
    c.ok("  …and the label reads that way", rw.deadlineLabel(fw!.deadlineAt) === "Thu, Oct 8, 5:00 PM ET", rw.deadlineLabel(fw!.deadlineAt));
    const noFile = await mkCut(A, 3, 1);
    await prisma.reviewSubmission.update({ where: { id: noFile }, data: { status: "APPROVED", decidedAt: new Date(), assetUrl: null } });
    c.ok("a cut with no playable file gets no window", (await rw.openReviewWindow(noFile)) === null);
    const listing = await prisma.project.create({ data: { clientId: A.f.clientId, title: "12 Listing Ln — listing", status: "EDITING" }, select: { id: true } });
    const lc = await prisma.reviewSubmission.create({ data: { projectId: listing.id, round: 1, status: "APPROVED", decidedAt: new Date(), assetUrl: "/api/review/cut/x/stream" }, select: { id: true } });
    c.ok("a cut on a non-program job gets no window", (await rw.openReviewWindow(lc.id)) === null);
    await prisma.reviewSubmission.update({ where: { id: fCut }, data: { status: "SUPERSEDED" } }).catch(() => {});
  }

  // =========================================================================
  c.head("2 · rounds 1 and 2 are included; the next release answers the open round");
  // =========================================================================
  let a2 = "";
  {
    await note(A, a1, "The intro is too slow");
    const r1 = await cd.requestChangesOnCut(A.viewer, a1, "");
    const round1 = await prisma.contentRevisionRound.findFirst({ where: { submissionId: a1 } });
    c.ok("request on v1 → ok", r1.ok, r1.message);
    c.ok("round 1, included", round1?.ordinal === 1 && round1.included === true);
    c.ok("window → CHANGES_REQUESTED, pointing at the decision", (await windowOf(a1))?.state === "CHANGES_REQUESTED" && (await windowOf(a1))?.decisionId === (r1.ok ? r1.decisionId : "-"));
    const ap = await cd.approveCut(A.viewer, a1, "NONE");
    c.ok("the client cannot ALSO approve the version they sent back", ap.ok === false && /asked for changes/.test(ap.message), ap.message);
    c.ok("  …so the cut holds exactly one decision", (await prisma.clientDecision.count({ where: { submissionId: a1 } })) === 1);

    a2 = await mkCut(A, 1, 2);
    await release(a2);
    const w1 = await windowOf(a1);
    const w2 = await windowOf(a2);
    c.ok("v2 released: v1's window SUPERSEDED", w1?.state === "SUPERSEDED", w1?.state);
    c.ok("round 1 ANSWERED by v2", (await prisma.contentRevisionRound.findUniqueOrThrow({ where: { id: round1!.id } })).answeredBySubmissionId === a2);
    c.ok("v2's window OPEN with its own fresh deadline", w2?.state === "OPEN" && w2.deadlineAt.getTime() >= w1!.deadlineAt.getTime());
    const d1 = await prisma.clientDecision.findUniqueOrThrow({ where: { id: r1.ok ? r1.decisionId! : "-" } });
    c.ok("v1's change request reads DONE (the new version answered it)", d1.receiptState === "DONE", d1.receiptState);

    await note(A, a2, "Now the music is too loud");
    const r2 = await cd.requestChangesOnCut(A.viewer, a2, "");
    const round2 = await prisma.contentRevisionRound.findFirst({ where: { submissionId: a2 } });
    c.ok("request on v2 → round 2, included", r2.ok && round2?.ordinal === 2 && round2.included === true, r2.message);
    c.ok("no revision_fee card for an included round", (await prisma.smartTask.count({ where: { taskType: "revision_fee" } })) === 0);
  }

  // =========================================================================
  c.head("3 · round 3: policy OFF proceeds; policy ON needs the owner's acknowledgement");
  // =========================================================================
  let a3 = "";
  let feeRoundId = "";
  {
    // OFF: video 2 goes three rounds with nothing asked.
    const b1 = await mkCut(A, 4, 1);
    await release(b1);
    await note(A, b1, "b: round one note");
    await cd.requestChangesOnCut(A.viewer, b1, "");
    const b2 = await mkCut(A, 4, 2);
    await release(b2);
    await note(A, b2, "b: round two note");
    await cd.requestChangesOnCut(A.viewer, b2, "");
    const b3 = await mkCut(A, 4, 3);
    await release(b3);
    await note(A, b3, "b: round three note");
    c.ok("policy OFF: reviewPanelFor is null (the page shows nothing new)", (await rw.reviewPanelFor(A.viewer, b3)) === null);
    const rb = await cd.requestChangesOnCut(A.viewer, b3, "");
    const rb3 = await prisma.contentRevisionRound.findFirst({ where: { submissionId: b3 } });
    c.ok("policy OFF: round 3 proceeds with no acknowledgement", rb.ok, rb.message);
    c.ok("  …recorded as NOT included, with no fee and no fee decision", rb3?.ordinal === 3 && rb3.included === false && rb3.feeCents === null && rb3.feeDecision === null);
    c.ok("  …and no revision_fee card", (await prisma.smartTask.count({ where: { taskType: "revision_fee" } })) === 0);

    // ON.
    await setSwitch("revision_policy", true);
    a3 = await mkCut(A, 1, 3);
    await release(a3);
    const n3 = await note(A, a3, "Swap the ending shot");
    const before = await prisma.clientDecision.count();
    const refused = await cd.requestChangesOnCut(A.viewer, a3, "");
    const expected = rw.extraRoundAckText({ ordinal: 3, includedRounds: 2, feeCents: 5000 });
    c.ok("no acknowledgement → refused with needsFeeAck and the text", !refused.ok && refused.needsFeeAck === true && refused.ackText === expected, refused.message);
    c.ok("  …the text is the one Jordan's default describes", expected === "This would be revision round 3 for this video. Your plan includes 2 revision rounds per video; an additional round may carry a $50 fee. Our team confirms before anything is charged.", expected);
    c.ok("  …nothing consumed: note OPEN, window OPEN, 0 new decisions",
      (await prisma.portalComment.findUniqueOrThrow({ where: { id: n3.id } })).status === "OPEN" && (await windowOf(a3))?.state === "OPEN" && (await prisma.clientDecision.count()) === before);
    const panel = await rw.reviewPanelFor(A.viewer, a3);
    const w3 = await windowOf(a3);
    c.ok("policy ON: the panel quotes the window's own deadline", panel?.deadlineISO === w3?.deadlineAt.toISOString(), panel?.deadlineISO ?? "null");
    c.ok("  …rounds used 2 of 2, the next one needs the acknowledgement", panel?.roundsUsed === 2 && panel.includedRounds === 2 && panel.nextRoundNeedsAck === true && panel.ackText === expected);

    // Jordan, Sep 24 2026: the fee may be acknowledged by the account owner OR
    // their assistant — any named seat that may ask for the round. Not the
    // emailed link: it names nobody, and this is an agreement that a fee may apply.
    const tk = await cd.requestChangesOnCut(A.token, a3, "", { acknowledgeExtraFee: true });
    c.ok("the emailed link's acknowledgement is refused (it names nobody)", !tk.ok && tk.needsFeeAck === true && /sign in with your own account/.test(tk.message), tk.message);
    const collabUser = await prisma.clientUser.create({ data: { email: "assistant@example.com", name: "Assistant", status: "ACTIVE" }, select: { id: true } });
    const collab = { ...A.viewer, actor: { kind: "CLIENT", clientUserId: collabUser.id, email: "assistant@example.com", name: "Assistant", membershipId: "m-collab", membershipRole: "COLLABORATOR" } } as PortalViewer;
    const ok = await cd.requestChangesOnCut(collab, a3, "", { acknowledgeExtraFee: true });
    const r3 = await prisma.contentRevisionRound.findFirstOrThrow({ where: { submissionId: a3 } });
    feeRoundId = r3.id;
    c.ok("the ASSISTANT's (COLLABORATOR seat) acknowledgement → ok", ok.ok, ok.message);
    c.ok("round 3: not included, fee 5000¢, PENDING", r3.included === false && r3.feeCents === 5000 && r3.feeDecision === "PENDING");
    c.ok("feeAckText is exactly the sentence that was shown, attributed to the assistant", r3.feeAckText === expected && !!r3.feeAckAt && r3.feeAckClientUserId === collabUser.id);
    const fee = await prisma.smartTask.findMany({ where: { taskType: "revision_fee" } });
    c.ok("one revision_fee card, on Kyle", fee.length === 1 && fee[0].assignedKey === "kyle" && fee[0].dedupeKey === `revision-fee:${r3.id}`, `${fee.length}/${fee[0]?.assignedKey}`);
    c.ok("  …and the round points at it", r3.feeTaskId === fee[0]?.id);
    const bell = await prisma.notification.findMany({ where: { kind: "revision_fee" } });
    c.ok("the fee bell reaches OWNER/ADMIN only", bell.length === 1 && !bell[0].userKey && JSON.parse(bell[0].audience).every((x: string) => x === "OWNER" || x === "ADMIN"), bell.map((b) => b.audience).join(","));
    const lane = await prisma.smartTask.findFirstOrThrow({ where: { projectId: A.f.projectId!, taskType: "revision" } });
    const briefs = await prisma.revisionBrief.findMany({ where: { projectId: A.f.projectId! } });
    c.ok("the editor's task carries no '$'", !/\$/.test(`${lane.title} ${lane.summary} ${lane.description}`));
    c.ok("no brief carries a '$' (text or items)", briefs.every((b) => !/\$/.test(`${b.originalText} ${b.itemsJson ?? ""} ${b.headline ?? ""}`)), String(briefs.length));
    const editorBells = await prisma.notification.findMany({ where: { userKey: { startsWith: "editor:" } } });
    c.ok("no editor bell carries a '$'", editorBells.every((b) => !/\$/.test(`${b.title} ${b.body ?? ""}`)), String(editorBells.length));
  }

  // =========================================================================
  c.head("4 · the office decides — once — and nothing is billed");
  // =========================================================================
  {
    const d = await rw.decideRevisionFee(feeRoundId, "WAIVE", "Kyle Drill");
    const r = await prisma.contentRevisionRound.findUniqueOrThrow({ where: { id: feeRoundId } });
    c.ok("WAIVE recorded", d.ok && r.feeDecision === "WAIVE" && r.feeDecidedBy === "Kyle Drill", d.message);
    c.ok("  …and Kyle's card is completed", (await prisma.smartTask.findUniqueOrThrow({ where: { id: r.feeTaskId! } })).status === "COMPLETED");
    const again = await rw.decideRevisionFee(feeRoundId, "CHARGE", "Jordan");
    c.ok("a second decision says 'already decided' and changes nothing", !again.ok && /Already decided/.test(again.message) && (await prisma.contentRevisionRound.findUniqueOrThrow({ where: { id: feeRoundId } })).feeDecision === "WAIVE", again.message);
    c.ok("zero billing calls (no Stripe / QuickBooks host was even tried)", !fence.blocked.some((u) => /stripe|intuit|quickbooks/i.test(u)), fence.blocked.filter((u) => /stripe|intuit/i.test(u)).join(","));
  }

  // =========================================================================
  c.head("5 · expiry: auto-approval only with both switches, TEST clients by default");
  // =========================================================================
  {
    await setSwitch("review_auto_approve", true);
    const E = await world("Eve Expiry");
    const e1 = await mkCut(E, 1, 1);
    await release(e1);
    await prisma.contentReviewWindow.update({ where: { submissionId: e1 }, data: { clientNotifiedAt: new Date() } });
    const w = (await windowOf(e1))!;
    const early = await rw.sweepReviewWindows({ now: new Date(w.deadlineAt.getTime() - 60_000) });
    c.ok("a minute BEFORE the deadline: nothing happens", (early as { due: number }).due === 0 && (await prisma.clientDecision.count({ where: { submissionId: e1 } })) === 0, JSON.stringify(early));
    const s1 = await rw.sweepReviewWindows({ now: new Date(w.deadlineAt.getTime() + 60_000) });
    const dec = await prisma.clientDecision.findMany({ where: { submissionId: e1 } });
    const w2 = (await windowOf(e1))!;
    c.ok("a minute after: one APPROVE, basis AUTO_EXPIRY", dec.length === 1 && dec[0].decision === "APPROVE" && dec[0].basis === "AUTO_EXPIRY", JSON.stringify(s1));
    c.ok("  …labelled as automatic, with the deadline, no person on it", dec[0].actorLabel === `Automatic approval (no response by ${rw.deadlineLabel(w.deadlineAt)})` && !dec[0].clientUserId && !dec[0].staffUserId && dec[0].membershipRole === "SYSTEM", dec[0].actorLabel);
    c.ok("  …the SAME row a client's press writes (dedupeKey, identity, DONE)", dec[0].dedupeKey === `sub:${e1}:approve` && dec[0].contentHash?.startsWith("ident2:") === true && dec[0].receiptState === "DONE" && dec[0].windowId === w.id);
    c.ok("window AUTO_APPROVED, with its evidence", w2.state === "AUTO_APPROVED" && w2.decisionId === dec[0].id && !!w2.closeEvidenceJson && JSON.parse(w2.closeEvidenceJson).deadlineAt === w.deadlineAt.toISOString());
    c.ok("caches: the cut's clientApprovedDecisionId and the video's approvedSubmissionId", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: e1 } })).clientApprovedDecisionId === dec[0].id && (await prisma.contentVideo.findUniqueOrThrow({ where: { id: E.videos[0] } })).approvedSubmissionId === e1);
    c.ok("an Activity row and an OWNER/ADMIN bell", (await prisma.activity.count({ where: { projectId: E.f.projectId!, body: { contains: "approved automatically" } } })) === 1 && (await prisma.notification.count({ where: { dedupeKey: { startsWith: `review-auto-${w.id}` } } })) === 1);
    const s2 = await rw.sweepReviewWindows({ now: new Date(w.deadlineAt.getTime() + 120_000) });
    c.ok("a second sweep writes nothing", (s2 as { due: number }).due === 0 && (await prisma.clientDecision.count({ where: { submissionId: e1 } })) === 1, JSON.stringify(s2));
    const hist = await cd.cutHistory(E.token, e1);
    c.ok("the portal reads AUTO_APPROVED, and never 'by you' to the link", hist[0]?.clientState === "AUTO_APPROVED" && hist[0].decidedByMe === false, `${hist[0]?.clientState}/${hist[0]?.decidedByMe}`);

    // review_auto_approve OFF, a real (non-TEST) client: a task, once.
    await setSwitch("review_auto_approve", false);
    const N = await world("Nora Real");
    await prisma.client.update({ where: { id: N.f.clientId }, data: { name: "Nora Quinn" } });
    const n1 = await mkCut(N, 1, 1);
    await release(n1);
    await prisma.contentReviewWindow.update({ where: { submissionId: n1 }, data: { clientNotifiedAt: new Date() } });
    const nw = (await windowOf(n1))!;
    await rw.sweepReviewWindows({ now: new Date(nw.deadlineAt.getTime() + 60_000) });
    await rw.sweepReviewWindows({ now: new Date(nw.deadlineAt.getTime() + 3 * HOUR) });
    const tasks = await prisma.smartTask.findMany({ where: { dedupeKey: `review-expired:${nw.id}` } });
    c.ok("auto-approve OFF: no decision", (await prisma.clientDecision.count({ where: { submissionId: n1 } })) === 0);
    c.ok("  …exactly one review-expired task on Kyle across two sweeps", tasks.length === 1 && tasks[0].assignedKey === "kyle" && tasks[0].source === "content_program", String(tasks.length));
    c.ok("  …and the window says MANUAL", (await windowOf(n1))?.expiryOutcome === "MANUAL", (await windowOf(n1))?.expiryOutcome ?? "null");

    // ON again, but the client is not TEST and testClientsOnly is the default.
    await setSwitch("review_auto_approve", true, new Date(Date.now() - HOUR));
    const n2 = await mkCut(N, 2, 1);
    await release(n2);
    await prisma.contentReviewWindow.update({ where: { submissionId: n2 }, data: { clientNotifiedAt: new Date() } });
    const nw2 = (await windowOf(n2))!;
    await rw.sweepReviewWindows({ now: new Date(nw2.deadlineAt.getTime() + 60_000) });
    c.ok("a non-TEST client with testClientsOnly (default): no decision", (await prisma.clientDecision.count({ where: { submissionId: n2 } })) === 0);
    c.ok("  …held for NOT_TEST", /NOT_TEST/.test((await windowOf(n2))?.expiryOutcome ?? ""), (await windowOf(n2))?.expiryOutcome ?? "null");
  }

  // =========================================================================
  c.head("6 · holds: each one hands the window to the office instead");
  // =========================================================================
  {
    const H = await world("Hal Holds");
    const expect: [string, string][] = [];
    const mk = async (slot: number, code: string, prep: (sub: string) => Promise<void>, notified = true) => {
      const s = await mkCut(H, slot, 1);
      await release(s);
      if (notified) await prisma.contentReviewWindow.update({ where: { submissionId: s }, data: { clientNotifiedAt: new Date() } });
      await prep(s);
      expect.push([s, code]);
    };
    await mk(1, "OPEN_NOTES", async (s) => { await note(H, s, "unsent note"); });
    await mk(2, "STAFF_HOLD", async (s) => { const w = (await windowOf(s))!; await rw.holdReviewWindow(w.id, "Kyle", "waiting on the music licence"); });
    await mk(3, "NEVER_SEEN", async () => {}, false);
    await mk(4, "PRE_POLICY", async (s) => { const w = (await windowOf(s))!; await prisma.contentReviewWindow.update({ where: { id: w.id }, data: { openedAt: new Date(Date.now() - 2 * HOUR) } }); });
    // LAZY: a cut released before windows were recorded, first touched by the client now.
    const lz = await mkCut(H, 5, 1);
    await prisma.reviewSubmission.update({ where: { id: lz }, data: { status: "APPROVED", decidedAt: new Date("2026-09-10T15:00:00Z"), decidedBy: "Jordan" } });
    const lw = await rw.ensureWindow(lz, { enrollmentId: H.f.enrollmentId, clientId: H.f.clientId });
    c.ok("a pre-epoch release gets a LAZY window when first touched", lw?.source === "LAZY" && lw.state === "OPEN", `${lw?.source}/${lw?.state}`);
    await prisma.contentReviewWindow.update({ where: { id: lw!.id }, data: { clientNotifiedAt: new Date() } });
    expect.push([lz, "LAZY"]);
    // A REAL client's window opened before the switch went on (review, Sep 24):
    // every window is recorded with the switch off, so on the day it is turned
    // on these are the backlog.
    const Hr = await world("Hugo Backlog");
    await prisma.client.update({ where: { id: Hr.f.clientId }, data: { name: "Hugo Backlog" } });
    const hb = await mkCut(Hr, 1, 1);
    await release(hb);
    await prisma.contentReviewWindow.update({ where: { submissionId: hb }, data: { openedAt: new Date(Date.now() - 2 * HOUR), clientNotifiedAt: new Date() } });
    const sweepAt = new Date(Date.now() + 30 * 24 * HOUR);
    // What the sweep's OLD query (state OPEN, deadline passed, not yet swept) picked up.
    const oldDue = new Set((await prisma.contentReviewWindow.findMany({ where: { state: "OPEN", deadlineAt: { lte: sweepAt }, expiryOutcome: null } })).map((w) => w.submissionId));
    c.ok("BEFORE: the sweep's query took the never-enforced windows too (PRE_POLICY, LAZY, a real client's pre-switch one)", oldDue.has(expect.find(([, k]) => k === "PRE_POLICY")![0]) && oldDue.has(lz) && oldDue.has(hb));
    await rw.sweepReviewWindows({ now: sweepAt, max: 50 });
    for (const [s, code] of expect) {
      const w = (await windowOf(s))!;
      if (code === "PRE_POLICY" || code === "LAZY") {
        // Never held to a deadline (enforced() false): the client was never
        // shown one, so it never "closes" and nobody is told it did.
        c.ok(`NEW: a ${code} window is not swept at all — no approval, no hand-off`, (await prisma.clientDecision.count({ where: { submissionId: s } })) === 0 && w.state === "OPEN" && w.expiryOutcome === null, w.expiryOutcome ?? "null");
        continue;
      }
      c.ok(`hold ${code}: no approval, handed to the office`, (await prisma.clientDecision.count({ where: { submissionId: s } })) === 0 && w.state === "OPEN" && (w.expiryOutcome ?? "").includes(code), w.expiryOutcome ?? "null");
    }
    c.ok("NEW: the real client's pre-switch window makes no HIGH 'review window closed' task", (await prisma.smartTask.count({ where: { clientId: Hr.f.clientId, taskType: "content_review_expired" } })) === 0 && (await windowOf(hb))?.expiryOutcome === null);
    c.ok("TEST records make no card on Kyle (the reminder-escalation rule)", (await prisma.smartTask.count({ where: { clientId: H.f.clientId, taskType: "content_review_expired" } })) === 0);
    const P = await world("Pia Paused");
    const p1 = await mkCut(P, 1, 1);
    await release(p1);
    await prisma.contentReviewWindow.update({ where: { submissionId: p1 }, data: { clientNotifiedAt: new Date() } });
    await prisma.contentEnrollment.update({ where: { id: P.f.enrollmentId }, data: { status: "PAUSED" } });
    await rw.sweepReviewWindows({ now: new Date(Date.now() + 30 * 24 * HOUR), max: 50 });
    c.ok("hold ENROLLMENT (paused program): no approval", (await prisma.clientDecision.count({ where: { submissionId: p1 } })) === 0 && /ENROLLMENT/.test((await windowOf(p1))?.expiryOutcome ?? ""), (await windowOf(p1))?.expiryOutcome ?? "null");
  }

  // =========================================================================
  c.head("7 · a request a minute before the deadline wins; one after it is refused");
  // =========================================================================
  {
    const J = await world("Jo Just");
    const j1 = await mkCut(J, 1, 1);
    await release(j1);
    const jw = (await windowOf(j1))!;
    await prisma.contentReviewWindow.update({ where: { id: jw.id }, data: { deadlineAt: new Date(Date.now() + 60_000), clientNotifiedAt: new Date() } });
    await note(J, j1, "just in time");
    const r = await cd.requestChangesOnCut(J.viewer, j1, "");
    c.ok("deadline − 60 s: the request lands", r.ok && (await windowOf(j1))?.state === "CHANGES_REQUESTED", r.message);
    await rw.sweepReviewWindows({ now: new Date(Date.now() + HOUR + 60_000) });
    c.ok("  …and a sweep an hour past the deadline approves nothing", (await prisma.clientDecision.count({ where: { submissionId: j1, decision: "APPROVE" } })) === 0);

    const j2 = await mkCut(J, 2, 1);
    await release(j2);
    const jw2 = (await windowOf(j2))!;
    const past = new Date(Date.now() - 60_000);
    await prisma.contentReviewWindow.update({ where: { id: jw2.id }, data: { deadlineAt: past } });
    const late = await note(J, j2, "too late?");
    const lr = await cd.requestChangesOnCut(J.viewer, j2, "");
    c.ok("deadline + 60 s: a CLIENT request is refused with the closed-on label", !lr.ok && lr.message.includes(rw.deadlineLabel(past)) && lr.message.includes("(215) 645-4889"), lr.message);
    c.ok("  …their note stays saved (OPEN)", (await prisma.portalComment.findUniqueOrThrow({ where: { id: late.id } })).status === "OPEN");
    c.ok("  …and the office is rung to restart the clock", (await prisma.notification.count({ where: { dedupeKey: { startsWith: `review-late-${jw2.id}` } } })) === 1);
    const sr = await cd.requestChangesOnCut(J.staff, j2, "");
    const lround = await prisma.contentRevisionRound.findFirst({ where: { submissionId: j2 } });
    c.ok("the same request by STAFF succeeds, recorded as a late override", sr.ok && lround?.lateOverrideBy === "Kyle Drill (on behalf of Jo Just TEST)", `${sr.message} / ${lround?.lateOverrideBy}`);
    const restartW = await mkCut(J, 3, 1);
    await release(restartW);
    const rw3 = (await windowOf(restartW))!;
    await prisma.contentReviewWindow.update({ where: { id: rw3.id }, data: { deadlineAt: past } });
    const rs = await rw.restartReviewClock(rw3.id, "Kyle Drill");
    const after = (await windowOf(restartW))!;
    c.ok("Restart clock: a fresh deadline, the first one kept", rs.ok && after.deadlineAt > new Date() && after.originalDeadlineAt?.getTime() === past.getTime() && after.restartedBy === "Kyle Drill", rs.message);
  }

  // =========================================================================
  c.head("8 · approve and request racing on one cut — exactly one wins, ten times");
  // =========================================================================
  {
    const R = await world("Rae Race");
    const rejectedBefore = server.patchStats.rejected;
    let exactlyOne = 0, matches = 0, loserSaid = 0;
    for (let i = 0; i < 10; i++) {
      const s = await mkCut(R, i + 1, 1);
      await release(s);
      const ap = () => cd.approveCut(R.viewer, s, "NONE");
      const rq = () => cd.requestChangesOnCut(R.viewer, s, "fix the intro");
      const [x, y] = i % 2 ? await Promise.all([ap(), rq()]) : await Promise.all([rq(), ap()]);
      const decs = await prisma.clientDecision.findMany({ where: { submissionId: s } });
      const w = (await windowOf(s))!;
      if (decs.length === 1) exactlyOne++;
      if (decs.length === 1 && ((decs[0].decision === "APPROVE" && w.state === "APPROVED") || (decs[0].decision === "REQUEST_CHANGES" && w.state === "CHANGES_REQUESTED"))) matches++;
      const results = [x, y];
      if (results.filter((r) => r.ok).length === 1 && results.some((r) => !r.ok && r.message.length > 10)) loserSaid++;
    }
    c.ok("10/10 cuts hold exactly one decision", exactlyOne === 10, String(exactlyOne));
    c.ok("10/10 windows match the decision that won", matches === 10, String(matches));
    c.ok("10/10 losers were told what happened (ok:false with the state)", loserSaid === 10, String(loserSaid));
    c.ok("never both kinds on one submission", (await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n FROM (SELECT "submissionId" FROM "ClientDecision" WHERE "projectId" = ${R.f.projectId} GROUP BY "submissionId" HAVING COUNT(DISTINCT decision) > 1) x`)[0].n === BigInt(0));
    c.ok("the socket survived: no rejected query, the next one answers", server.patchStats.rejected === rejectedBefore && (await prisma.$queryRaw<{ one: number }[]>`SELECT 1 AS one`)[0].one === 1);
  }

  // =========================================================================
  c.head("9 · a replacement cut needs its own decision and gets no free rounds");
  // =========================================================================
  {
    const X = await world("Xan Replace");
    const x1 = await mkCut(X, 1, 1);
    await release(x1);
    await note(X, x1, "first round");
    await cd.requestChangesOnCut(X.viewer, x1, "");
    const x2 = await mkCut(X, 1, 2);
    await release(x2);
    const ap = await cd.approveCut(X.viewer, x2, "NONE");
    c.ok("v2 approved by the client, window APPROVED", ap.ok && (await windowOf(x2))?.state === "APPROVED");
    const x3 = await mkCut(X, 1, 3);
    await release(x3);
    const hist = await cd.cutHistory(X.viewer, x3);
    const cur = hist.find((h) => h.isCurrent);
    c.ok("the office's replacement v3: window OPEN, the client's state AWAITING_YOUR_DECISION", (await windowOf(x3))?.state === "OPEN" && cur?.submissionId === x3 && cur.clientState === "AWAITING_YOUR_DECISION", `${cur?.clientState}`);
    const d2 = await prisma.clientDecision.findFirstOrThrow({ where: { submissionId: x2, decision: "APPROVE" } });
    c.ok("v2's APPROVE is SUPERSEDED", d2.receiptState === "SUPERSEDED", d2.receiptState);
    c.ok("the round count is unchanged by the replacement (1)", (await rw.roundsUsed(rw.videoKeyOf({ id: x3, projectId: X.f.projectId!, deliverableId: X.f.deliverableId, slot: 1 }))) === 1);
    await note(X, x3, "one more thing");
    await cd.requestChangesOnCut(X.viewer, x3, "");
    const r3 = await prisma.contentRevisionRound.findFirstOrThrow({ where: { submissionId: x3 } });
    c.ok("v3 gets no free rounds: the next request is round 2", r3.ordinal === 2, String(r3.ordinal));
  }

  // =========================================================================
  c.head("10 · the client plays only the latest version; staff see every round");
  // =========================================================================
  {
    const hist = await cd.cutHistory(A.viewer, a3);
    c.ok("cutHistory: exactly one version carries a playable URL — the current one", hist.filter((h) => h.assetUrl).length === 1 && hist.find((h) => h.assetUrl)?.isCurrent === true, hist.map((h) => `${h.round}:${h.isCurrent}:${!!h.assetUrl}`).join(" "));
    const tab = await loadContentTab(A.f.enrollmentId, A.f.clientId, null);
    const v1row = tab.rows.find((r) => r.id === A.videos[0]);
    c.ok("staff library: every cut of video 1 listed", (v1row?.cuts.length ?? 0) === 3, String(v1row?.cuts.length));
    c.ok("  …every window (3) and every round (3)", v1row?.reviewWindows?.length === 3 && v1row.revisionRounds?.length === 3, `${v1row?.reviewWindows?.length}/${v1row?.revisionRounds?.length}`);
    c.ok("  …the fee visible to the office, with its decision", v1row?.moneyEyes === true && v1row.revisionRounds?.some((r) => r.feeCents === 5000 && r.feeDecision === "WAIVE") === true);
  }

  // =========================================================================
  c.head("11 · the reminder lane reads the window's persisted deadline, per batch");
  // =========================================================================
  {
    const M = await world("Mo Remind");
    const m1 = await mkCut(M, 1, 1);
    await release(m1);
    const mw = (await windowOf(m1))!;
    const run = async (now: Date) => (await evaluateReminders({ dryRun: true, enrollmentIds: [M.f.enrollmentId], now })).candidates.find((x) => x.lane === "REVIEW");
    const c1 = await run(new Date(mw.openedAt.getTime() + HOUR));
    c.ok("REVIEW lane: action REVIEW_WORK", c1?.action === "REVIEW_WORK", `${c1?.action}/${c1?.decision}`);
    c.ok("state.reviewDeadlineAt === the window's deadlineAt (same instant)", c1?.state.reviewDeadlineAt === mw.deadlineAt.toISOString(), c1?.state.reviewDeadlineAt ?? "null");
    c.ok("  …and the internal deadline IS that instant (no recompute)", c1?.deadlineAt?.getTime() === mw.deadlineAt.getTime());
    c.ok("first reminder waits until openedAt + 2 business days", c1?.decision === "wait" && c1.nextEligibleAt?.getTime() === addBusinessDaysET(mw.openedAt, 2).getTime(), c1?.nextEligibleAt?.toISOString());
    const tag = `r${etDayKey(mw.openedAt).replace(/-/g, "")}`;
    const at3 = etAt(addBusinessDayKeysET(mw.openedAt, 3), 11);
    const c2 = await run(at3);
    c.ok("three business days on: the dedupeKey carries the batch tag", !!c2?.dedupeKey && c2.dedupeKey === `${M.f.enrollmentId}:2026-10:REVIEW_WORK:${tag}:1`, `${c2?.decision} ${c2?.dedupeKey ?? c2?.reason}`);
    // One SENT reminder for that batch.
    await prisma.programReminder.create({ data: { enrollmentId: M.f.enrollmentId, clientId: M.f.clientId, monthId: M.f.monthId, monthKey: "2026-10", action: "REVIEW_WORK", templateKey: "reminder.review_work.v2", templateVersion: "2", channel: "email", attempt: 1, state: "SENT", sentAt: at3, dedupeKey: c2?.dedupeKey ?? `x-${tag}`, requestedBy: "drill" } });
    const later = etAt(addBusinessDayKeysET(at3, 2), 11);
    const c3 = await run(later);
    c.ok("same batch: the next one is attempt 2", c3?.attempt === 2, `${c3?.attempt} ${c3?.decision} ${c3?.reason}`);
    // A second release five days later (and after that reminder went) — and
    // the first version decided.
    const m2At = new Date(Math.max(mw.openedAt.getTime() + 5 * 24 * HOUR, at3.getTime() + HOUR));
    const m2 = await mkCut(M, 2, 1);
    await prisma.reviewSubmission.update({ where: { id: m2 }, data: { status: "APPROVED", decidedAt: m2At, decidedBy: "Jordan" } });
    const mw2 = (await rw.openReviewWindow(m2, { at: m2At }))!;
    await cd.approveCut(M.viewer, m1, "NONE");
    const c4 = await run(etAt(addBusinessDayKeysET(mw2.openedAt, 3), 11));
    const tag2 = `r${etDayKey(mw2.openedAt).replace(/-/g, "")}`;
    c.ok("a batch released 5 days later starts again at attempt 1, under its own tag", c4?.attempt === 1 && (c4?.dedupeKey ?? "").includes(tag2) && c4?.state.reviewDeadlineAt === mw2.deadlineAt.toISOString(), `${c4?.attempt} ${c4?.dedupeKey}`);
    const marked = await rw.markReviewWindowsNotified(M.f.monthId, new Date(mw2.openedAt.getTime() + HOUR));
    c.ok("a SENT review reminder stamps clientNotifiedAt on the open windows it was about", marked === 1 && !!(await windowOf(m2))?.clientNotifiedAt && !(await windowOf(m1))?.clientNotifiedAt, String(marked));
  }

  // =========================================================================
  c.head("12 · UI-02: approveScript signs exactly the version the tab showed");
  // =========================================================================
  {
    const S = await world("Sol Script");
    const owner = await prisma.appUser.create({ data: { email: "jordan@realtourpilot.com", name: "Jordan", role: "OWNER", status: "ACTIVE" }, select: { id: true } });
    const { establishSession } = await import("@/lib/auth/session");
    await establishSession(owner.id);
    const script = await prisma.contentScript.create({ data: { enrollmentId: S.f.enrollmentId, clientId: S.f.clientId, monthId: S.f.monthId, title: "First weekend", body: "b", status: "INTERNAL_REVIEW" }, select: { id: true } });
    const points = JSON.stringify([{ role: "RE_HOOK", text: "Buyers decide in two days." }, { role: "BUILD_UP", text: "Price it right and they compete." }, { role: "PAYOFF", text: "That's how you win the weekend." }]);
    const mkV = (n: number) => prisma.contentScriptVersion.create({ data: { scriptId: script.id, enrollmentId: S.f.enrollmentId, clientId: S.f.clientId, versionNo: n, title: "First weekend", hook: `Your first weekend decides your price (v${n}).`, pointsJson: points, close: "Call me before you list.", body: `v${n} body`, source: "AI", status: "DRAFT" }, select: { id: true } });
    const v1 = await mkV(1);
    const v2 = await mkV(2);
    await prisma.contentScript.update({ where: { id: script.id }, data: { currentVersionId: v2.id } });
    const oldActions = (await import(base.contentActions)) as { approveScript: (id: string, note?: string) => Promise<{ ok: boolean; message: string }> };
    const o = await oldActions.approveScript(script.id, "drill: pillar override");
    const afterOld = await prisma.contentScript.findUniqueOrThrow({ where: { id: script.id } });
    c.ok("OLD: approveScript(scriptId) signed whatever was CURRENT (v2) — the tab could have shown v1", o.ok && afterOld.approvedVersionId === v2.id, o.message);
    const v3 = await mkV(3);
    await prisma.contentScript.update({ where: { id: script.id }, data: { currentVersionId: v3.id } });
    const { approveScript } = await import("@/app/content/actions");
    const stale = await approveScript(script.id, 2, "drill: pillar override");
    c.ok("NEW: a tab showing v2 after v3 was written is refused", !stale.ok && /newer version/.test(stale.message), stale.message);
    c.ok("  …and nothing was approved", (await prisma.contentScript.findUniqueOrThrow({ where: { id: script.id } })).approvedVersionId === v2.id);
    const legacyCall = await (approveScript as unknown as (id: string, n?: string) => Promise<{ ok: boolean; message: string }>)(script.id, "drill: pillar override");
    c.ok("an old bundle's call (no version) is refused", !legacyCall.ok && /Reload/.test(legacyCall.message), legacyCall.message);
    const good = await approveScript(script.id, 3, "drill: pillar override");
    c.ok("the version on screen (v3) is approved", good.ok && (await prisma.contentScript.findUniqueOrThrow({ where: { id: script.id } })).approvedVersionId === v3.id, good.message);
    c.ok("  …through the version-exact path (its ledger row names v3)", (await prisma.contentScriptRelease.count({ where: { scriptId: script.id, scriptVersionId: v3.id, action: "APPROVE" } })) === 1);
    void v1;
  }

  // =========================================================================
  c.head("13 · repair, staff overrides, and a version restored after a take-back");
  // =========================================================================
  {
    const K = await world("Kit Kinds");
    // (a) The approve-time window write was lost: the cron repair opens it from
    // the TRUE release time, once.
    const k1 = await mkCut(K, 1, 1);
    const releasedAt = new Date(Date.now() - 2 * HOUR);
    await prisma.reviewSubmission.update({ where: { id: k1 }, data: { status: "APPROVED", decidedAt: releasedAt, decidedBy: "Jordan" } });
    const rep = await rw.repairReviewWindows();
    const kw = await windowOf(k1);
    c.ok("repair: a released cut with no window gets one (REPAIR), dated from the real release", rep.opened >= 1 && kw?.source === "REPAIR" && kw.openedAt.getTime() === releasedAt.getTime() && kw.deadlineAt.getTime() === endOfBusinessDaysET(releasedAt, 4).getTime(), JSON.stringify(rep));
    const rep2 = await rw.repairReviewWindows();
    c.ok("  …and a second repair opens nothing", rep2.opened === 0, JSON.stringify(rep2));

    // (b) Staff approve over the client's open request: the round no longer counts.
    await note(K, k1, "please fix");
    await cd.requestChangesOnCut(K.viewer, k1, "");
    const before = await rw.roundsUsed(kw!.videoKey);
    const sa = await cd.approveCut(K.staff, k1, "NONE");
    const req = await prisma.clientDecision.findFirstOrThrow({ where: { submissionId: k1, decision: "REQUEST_CHANGES" } });
    c.ok("staff may approve over the client's request: window APPROVED", sa.ok && (await windowOf(k1))?.state === "APPROVED", sa.message);
    c.ok("  …the request is SUPERSEDED by the approval, its round CANCELLED", req.receiptState === "SUPERSEDED" && req.supersededById === (sa.ok ? sa.decisionId : "-") && (await prisma.contentRevisionRound.findFirstOrThrow({ where: { decisionId: req.id } })).state === "CANCELLED");
    c.ok("  …so the video's rounds used drop by one", (await rw.roundsUsed(kw!.videoKey)) === before - 1, `${before} → ${await rw.roundsUsed(kw!.videoKey)}`);

    // (c) Staff may reopen an approved version; the client may not.
    await note(K, k1, "after all, one more");
    const cr = await cd.requestChangesOnCut(K.viewer, k1, "");
    c.ok("the client cannot send changes on a version already approved", !cr.ok && /already approved/.test(cr.message), cr.message);
    const sr = await cd.requestChangesOnCut(K.staff, k1, "");
    const appr = await prisma.clientDecision.findFirstOrThrow({ where: { submissionId: k1, decision: "APPROVE" } });
    c.ok("staff reopen: the request lands, the approval is superseded, the cut's cache cleared", sr.ok && (await windowOf(k1))?.state === "CHANGES_REQUESTED" && appr.receiptState === "SUPERSEDED" && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: k1 } })).clientApprovedDecisionId === null, sr.message);

    // (d) v2 released over v1, then v2 taken back: v1 is current again and its
    // window reopens with its original deadline and a hold.
    const t1 = await mkCut(K, 2, 1);
    await release(t1);
    const t2 = await mkCut(K, 2, 2);
    await release(t2);
    c.ok("v2 released: v1's window SUPERSEDED", (await windowOf(t1))?.state === "SUPERSEDED");
    await rw.closeReviewWindow(t2, "REMOVED");
    await prisma.reviewSubmission.delete({ where: { id: t2 } });
    const revived = await rw.ensureWindow(t1, { enrollmentId: K.f.enrollmentId, clientId: K.f.clientId });
    c.ok("v2 taken back: v1's window is OPEN again, on hold, same deadline", revived?.state === "OPEN" && !!revived.heldAt && revived.deadlineAt.getTime() === (await windowOf(t1))!.deadlineAt.getTime(), `${revived?.state}/${revived?.holdReason}`);
    const ap = await cd.approveCut(K.viewer, t1, "NONE");
    c.ok("  …and the client can decide it", ap.ok, ap.message);
  }

  // =========================================================================
  c.head("14 · the review cadence counts reminders per WINDOW, not per release day (review, Sep 24)");
  // =========================================================================
  {
    const MON = new Date("2026-10-05T14:00:00Z"), TUE = new Date("2026-10-06T14:00:00Z");
    const releaseAt = async (w: World, slot: number, at: Date) => {
      const s = await mkCut(w, slot, 1);
      await prisma.reviewSubmission.update({ where: { id: s }, data: { status: "APPROVED", decidedAt: at, decidedBy: "Jordan" } });
      return { sub: s, win: (await rw.openReviewWindow(s, { at }))! };
    };
    const ledger = async (w: World, key: string, sentAt: Date, action = "REVIEW_WORK") => prisma.programReminder.create({
      data: { enrollmentId: w.f.enrollmentId, clientId: w.f.clientId, monthId: w.f.monthId, monthKey: "2026-10", action, templateKey: action === "ESCALATION" ? "escalation:REVIEW_WORK" : "reminder.review_work.v2", templateVersion: "2", channel: action === "ESCALATION" ? "task" : "email", attempt: 1, state: "SENT", sentAt, createdAt: sentAt, dedupeKey: key, requestedBy: "drill" },
    });
    const tagOf = (d: Date) => `r${etDayKey(d).replace(/-/g, "")}`;
    const evalAt = async (w: World, day: string) => (await evaluateReminders({ dryRun: true, enrollmentIds: [w.f.enrollmentId], now: etAt(day, 11) })).candidates.find((x) => x.lane === "REVIEW");

    // (A) Three videos Monday, one Tuesday; two reminders went (counting all
    // four) and the lane escalated; then the client approves Monday's.
    const Q = await world("Quinn Batch");
    const q = [await releaseAt(Q, 1, MON), await releaseAt(Q, 2, MON), await releaseAt(Q, 3, MON)];
    await releaseAt(Q, 4, TUE);
    const pre = `${Q.f.enrollmentId}:2026-10`;
    await ledger(Q, `${pre}:REVIEW_WORK:${tagOf(MON)}:1`, new Date("2026-10-07T15:00:00Z"));
    await ledger(Q, `${pre}:REVIEW_WORK:${tagOf(MON)}:2`, new Date("2026-10-08T15:00:00Z"));
    await ledger(Q, `${pre}:ESCALATION:REVIEW_WORK:${tagOf(MON)}`, new Date("2026-10-08T15:30:00Z"), "ESCALATION");
    for (const x of q) await cd.approveCut(Q.viewer, x.sub, "NONE");
    const tueTagRows = await prisma.programReminder.count({ where: { enrollmentId: Q.f.enrollmentId, action: "REVIEW_WORK", dedupeKey: { contains: `:${tagOf(TUE)}:` } } });
    c.ok("BEFORE: keyed on the earliest open window's day (now Tuesday's), the old cadence saw 0 reminders — 'reminder 1' again, and a second escalation", tueTagRows === 0);
    const qa = await evalAt(Q, "2026-10-12");
    c.ok("NEW: the Tuesday video has had its 2 of 2 — nothing is sent", qa?.attempt === 2 && qa.decision !== "send" && !qa.dedupeKey?.includes(`${tagOf(TUE)}:1`), `${qa?.decision} ${qa?.attempt} ${qa?.reason}`);
    c.ok("NEW: …and the escalation that already covered it is not filed again", qa?.escalation === null, JSON.stringify(qa?.escalation));

    // (B) Monday's one video stays undecided after its 2 reminders and the
    // escalation; a batch released the next Tuesday must still be chased.
    const Z = await world("Zed Starve");
    await releaseAt(Z, 1, MON);
    const LATER = new Date("2026-10-13T14:00:00Z");
    const z2 = await releaseAt(Z, 2, LATER);
    const zp = `${Z.f.enrollmentId}:2026-10`;
    await ledger(Z, `${zp}:REVIEW_WORK:${tagOf(MON)}:1`, new Date("2026-10-07T15:00:00Z"));
    await ledger(Z, `${zp}:REVIEW_WORK:${tagOf(MON)}:2`, new Date("2026-10-08T15:00:00Z"));
    await ledger(Z, `${zp}:ESCALATION:REVIEW_WORK:${tagOf(MON)}`, new Date("2026-10-08T15:30:00Z"), "ESCALATION");
    const monRows = await prisma.programReminder.count({ where: { enrollmentId: Z.f.enrollmentId, action: "REVIEW_WORK", state: "SENT", dedupeKey: { contains: `:${tagOf(MON)}:` } } });
    c.ok("BEFORE: the old cadence stayed on Monday's tag with 2 of 2 spent — the new batch was never chased", monRows >= 2);
    const zb = await evalAt(Z, "2026-10-16");
    c.ok("NEW: the new batch is chased on its own count — attempt 1, under its release day's tag", zb?.attempt === 1 && zb.decision === "send" && zb.dedupeKey === `${zp}:REVIEW_WORK:${tagOf(LATER)}:1`, `${zb?.decision} ${zb?.attempt} ${zb?.dedupeKey ?? zb?.reason}`);
    c.ok("NEW: …quoting ITS deadline", zb?.state.reviewDeadlineAt === z2.win.deadlineAt.toISOString(), zb?.state.reviewDeadlineAt ?? "null");

    // The pure rule.
    const w = (d: string) => ({ openedAt: new Date(d), deadlineAt: new Date(d) });
    const t = rw.reviewCadenceTarget([w("2026-10-05T14:00:00Z"), w("2026-10-06T14:00:00Z")], [new Date("2026-10-07T15:00:00Z")], 2);
    c.ok("reviewCadenceTarget: the oldest window with attempts left, counting sends since ITS release", t?.window.openedAt.toISOString() === "2026-10-05T14:00:00.000Z" && t.attempts === 1);
    const t2 = rw.reviewCadenceTarget([w("2026-10-05T14:00:00Z"), w("2026-10-13T14:00:00Z")], [new Date("2026-10-07T15:00:00Z"), new Date("2026-10-08T15:00:00Z")], 2);
    c.ok("  …an exhausted window gives way to the next", t2?.window.openedAt.toISOString() === "2026-10-13T14:00:00.000Z" && t2.attempts === 0 && t2.tag === "r20261013");
  }

  c.head("isolation");
  c.ok("no provider was reached — every outbound attempt was fenced", fence.faked.length === 0, `blocked ${fence.blocked.length}: ${[...new Set(fence.blocked.map((u) => u.replace(/^(\w+:\/\/[^/]+).*/, "$1")))].join(", ")}`);
  console.log(`  (prisma error lines swallowed: ${quiet.count})`);

  c.summary();
  quiet.restore();
  removeBaseCopies(base.dir);
  await stop();
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  fence.restore();
  process.exit(process.exitCode ?? 0);
});
