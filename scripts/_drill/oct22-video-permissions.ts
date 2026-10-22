// ---------------------------------------------------------------------------
// DRILL: VIDEO REVIEW PERMISSIONS AND CLIENT WORDING (audit M5 / P-M1 / P-M2,
// M6 / P-M3, M7, L6 / P-L1, P-L2; Oct 22 2026).
//
//   DRILL_PORT=6995 node scripts/_drill/run-all.cjs scripts/_drill/oct22-video-permissions.ts
//
//   1. Taking back a cut: the creative manager may pull a cut still waiting on
//      a verdict, never an approved or sent one, and never the Dropbox file;
//      Kyle and Jordan may. cutTakeBackFlags answers only the job's people.
//   2. Nobody approves a version they uploaded (the login on its check).
//   3. The 4K over-spec override is office only.
//   4. /review/<id>: client words money-scrubbed for all but Jordan and Kyle.
//   5. A video reopened by a client text keeps its review window closed; the
//      repair job no longer flips it back to OPEN.
//   6. Topaz spending limits: the owner's alone; Kyle sees no credit money.
// Isolated PGlite; nothing leaves the process.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6995);
const REPO = fs.realpathSync(path.resolve(__dirname, "../.."));
const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

installNextStubs();
const fence = fenceFetch();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const warn = console.warn;
  try {
    const { prisma } = await import("@/lib/prisma");
    const { establishSession } = await import("@/lib/auth/session");
    const actions = await import("@/app/review/actions");

    const tm = (name: string, role: "ADMIN" | "PHOTOGRAPHER" | "EDITOR", extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}-vp@drill.invalid`, role, active: true, ...extra } });
    const login = (name: string, role: string, teamMemberId: string | null, editorKey: string | null = null) =>
      prisma.appUser.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}-vp@drill.invalid`, role, status: "ACTIVE", teamMemberId, editorKey } });
    const jordan = await login("Jordan Drill", "OWNER", (await tm("Jordan Drill", "ADMIN")).id);
    const kyle = await login("Kyle Drill", "ADMIN", (await tm("Kyle Drill", "ADMIN")).id);
    const james = await login("James Drill", "CREATIVE_MANAGER", (await tm("James Drill", "PHOTOGRAPHER", { creativeManager: true })).id);
    const john = await login("John Mark", "EDITOR", (await tm("John Mark", "EDITOR")).id, "john");
    const client = await prisma.client.create({ data: { name: "Perm Drill" } });
    const job = async (street: string) => (await prisma.project.create({
      data: {
        title: `${street}, Testville, PA`, clientId: client.id, status: "REVIEW", shootDate: new Date("2026-10-20T13:00:00Z"),
        deliverables: { create: [{ type: "SOCIAL_REEL", label: "Standard Video Highlight Reel", productTitle: "Standard Video Highlight Reel", videoStyle: "standard_reel", status: "UPLOADED" }] },
      },
      select: { id: true, deliverables: { select: { id: true } } },
    }));
    const P = await job("1 Held Rd");
    const Q = await job("2 Other Rd");
    await prisma.smartTask.create({ data: { taskType: "edit_video", status: "OPEN", assignedKey: "john", projectId: P.id, dedupeKey: `edit-video-${P.id}`, title: "Edit — 1 Held Rd", source: "system", priority: "MEDIUM" } });
    const dP = P.deliverables[0].id;
    const approved = await prisma.reviewSubmission.create({ data: { projectId: P.id, deliverableId: dP, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "v1.mp4", submittedByKey: "john", decidedAt: new Date(), finalPath: "/Final/v1.mp4" } });
    const pending = await prisma.reviewSubmission.create({ data: { projectId: P.id, deliverableId: dP, slot: 2, round: 1, status: "PENDING", source: "upload", fileName: "v2.mp4", submittedByKey: "john" } });
    await prisma.reviewSubmission.create({ data: { projectId: Q.id, deliverableId: Q.deliverables[0].id, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "q.mp4", submittedByKey: "kim" } });

    // =====================================================================
    c.head("1 · Taking back a cut");
    // =====================================================================
    await establishSession(james.id);
    const jf = await actions.cutTakeBackFlags(P.id);
    const jA = jf.find((f) => f.submissionId === approved.id);
    const jP = jf.find((f) => f.submissionId === pending.id);
    c.ok("James: a cut waiting on a verdict, his to remove or move (Oct 21 tidy-up kept)", !!jP?.canRemove && !!jP.canMove, JSON.stringify(jP));
    c.ok("James: an approved cut is not (office only)", !!jA && !jA.canRemove && !jA.canMove, JSON.stringify(jA));
    c.ok("James: never the Dropbox-delete control", jf.every((f) => !f.office));
    const pulled = await actions.removeCut(approved.id, "wrong file", true);
    c.ok("James's remove of the approved cut is refused in words; the cut stays", !pulled.ok && /approved this cut/.test(pulled.message) && !!(await prisma.reviewSubmission.findUnique({ where: { id: approved.id } })), pulled.message);
    await establishSession(kyle.id);
    const kf = await actions.cutTakeBackFlags(P.id);
    c.ok("Kyle: the approved cut is his to pull, with the Dropbox control", !!kf.find((f) => f.submissionId === approved.id)?.canRemove && kf.every((f) => f.office));
    await establishSession(john.id);
    c.ok("John (editor) on a job he holds: his cuts are listed", (await actions.cutTakeBackFlags(P.id)).length === 2);
    c.ok("John on another job's id: nothing (P-L2)", (await actions.cutTakeBackFlags(Q.id)).length === 0);
    const src = read("src/app/review/actions.ts");
    c.ok("the Dropbox file is taken only by the office (isOffice), and James's lead role scopes only pending work", /const office = isOffice\(me\.realRole\);/.test(src) && /const takeDropboxToo = alsoDeleteDropboxFile && who\.actor\.office && !!hubCopyPath;/.test(src) && /if \(sub\.status === "APPROVED" && !actor\.office\)/.test(src) && /if \(!actor\.lead && !mine\)/.test(src));

    // =====================================================================
    c.head("2 · Nobody approves a version they uploaded");
    // =====================================================================
    const R = await job("3 Upload Rd");
    const own = await prisma.reviewSubmission.create({ data: { projectId: R.id, deliverableId: R.deliverables[0].id, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "mine.mp4", submittedByKey: null, selfCheckedAt: new Date() } });
    const check = await prisma.cutSelfCheck.create({ data: { submissionId: own.id, projectId: R.id, deliverableId: R.deliverables[0].id, slot: 1, round: 1, editorKey: "john", actorUserId: jordan.id, actorName: "Jordan Drill", onBehalfOf: "john", checklistKey: "standard", itemsJson: "[]", state: "VALID" } });
    await prisma.reviewSubmission.update({ where: { id: own.id }, data: { selfCheckId: check.id } });
    await establishSession(jordan.id);
    const refused = await actions.approveCut(own.id);
    c.ok("Jordan uploaded it (no editor key on the row): his approval is refused", !refused.ok && refused.message === "You uploaded this version, so somebody else approves it.", refused.message);
    c.ok("…the cut is still waiting", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: own.id } })).status === "PENDING");
    const { refuseOwnUpload } = await import("@/lib/reviewerAssignment");
    c.ok("Kyle, who did not upload it, passes this check", (await refuseOwnUpload({ id: kyle.id, impersonating: false }, own.id)) === null);
    c.ok("the creative manager's upload is the same rule (his login is on the check)", (await refuseOwnUpload({ id: james.id, impersonating: false }, own.id)) === null && /refuseOwnUpload\(meNow, submission\.id\)/.test(src));

    // =====================================================================
    c.head("3 · The 4K over-spec override is office only");
    // =====================================================================
    c.ok("mayOverride = isOffice(who.role)", /const mayOverride = isOffice\(who\.role\);/.test(src) && !/mayOverride = isCreativeLead/.test(src));

    // =====================================================================
    c.head("4 · /review/<id>: client words money-scrubbed");
    // =====================================================================
    const { clientNotesForReviewRoom, HELD_BACK_NOTE } = await import("@/lib/clientDecisions");
    const enr = "enr-vp-1";
    await prisma.portalComment.create({ data: { submissionId: pending.id, projectId: P.id, enrollmentId: enr, body: "Love the kitchen shot. We dropped the price to $725,000 so please update the end card.", status: "OPEN" } });
    await prisma.portalComment.create({ data: { submissionId: pending.id, projectId: P.id, enrollmentId: enr, body: "Our invoice of $450 is paid already.", status: "OPEN" } });
    const raw = (await clientNotesForReviewRoom(P.id, 30)).flatMap((g) => g.notes.map((n) => n.body));
    const scrubbed = (await clientNotesForReviewRoom(P.id, 30, { scrub: true })).flatMap((g) => g.notes.map((n) => n.body));
    c.ok("unscrubbed (the owner and Kyle): the words as written", raw.some((b) => /\$725,000/.test(b)));
    c.ok("scrubbed: the billing sentence goes; a note that was all billing reads as held back", !scrubbed.some((b) => /\$450/.test(b)) && scrubbed.includes(HELD_BACK_NOTE) && scrubbed.some((b) => /^Love the kitchen shot\./.test(b)), JSON.stringify(scrubbed));
    const page = read("src/app/review/[id]/page.tsx");
    c.ok("the page scrubs for everyone but OWNER and ADMIN (the /edit gate)", /const canSeeRaw = me\?\.role === "OWNER" \|\| me\?\.role === "ADMIN";/.test(page) && /stripMoneySentences\(s\) \|\| HELD_BACK_NOTE/.test(page));
    c.ok("…on the round's ask, the portal notes, the fixes to check and the creative reviews", /\{clientWords\(plainAsk\(/.test(page) && /clientNotesForReviewRoom\(id, 30, \{ scrub: !canSeeRaw \}\)/.test(page) && /issuesForProject\(w\.projectId, \{ scrub: !canSeeRaw \}\)/.test(page) && /originalText: clientWords\(r\.originalText\)/.test(page));
    c.ok("a seated photographer never reads the client's ask: clientAsk skipped and roundAsk gated", /const clientAsk = active && !shotThis/.test(page) && /const roundAsk = !shotThis && /.test(page));

    // =====================================================================
    c.head("5 · Reopened by a client text: the window stays closed");
    // =====================================================================
    const W = await job("4 Portal Rd");
    const v1 = await prisma.reviewSubmission.create({ data: { projectId: W.id, deliverableId: W.deliverables[0].id, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "w.mp4", decidedAt: new Date(Date.now() - 3600_000) } });
    const win = await prisma.contentReviewWindow.create({ data: { submissionId: v1.id, videoKey: `${W.id}:w`, projectId: W.id, enrollmentId: "enr-vp-2", clientId: client.id, round: 1, openedAt: new Date(Date.now() - 3600_000), deadlineAt: new Date(Date.now() + 3 * 86_400_000) } });
    const { reopenApprovedCut } = await import("@/lib/cutReopen");
    console.warn = () => {};
    const re = await reopenApprovedCut(v1.id, { by: "The client", why: "They texted", source: "text" });
    console.warn = warn;
    const w1 = await prisma.contentReviewWindow.findUniqueOrThrow({ where: { id: win.id } });
    c.ok("the reopen closes the window as changes requested (REOPENED_TEXT)", re.reopened && w1.state === "CHANGES_REQUESTED" && w1.closedReason === "REOPENED_TEXT" && !w1.decisionId, JSON.stringify({ re, state: w1.state, why: w1.closedReason }));
    const { repairPortalRevisionRequests } = await import("@/lib/clientDecisions");
    const later = new Date(Date.now() + 10 * 60_000);
    await prisma.contentReviewWindow.update({ where: { id: win.id }, data: { updatedAt: new Date(Date.now() - 5 * 60_000) } });
    const rep = await repairPortalRevisionRequests({ now: later });
    const w2 = await prisma.contentReviewWindow.findUniqueOrThrow({ where: { id: win.id } });
    c.ok("the repair job leaves it: still CHANGES_REQUESTED, not OPEN (it used to be given back)", w2.state === "CHANGES_REQUESTED" && rep.released === 0, JSON.stringify({ state: w2.state, rep }));
    // Control: a request whose decision never got written is still given back.
    const v2 = await prisma.reviewSubmission.create({ data: { projectId: W.id, deliverableId: W.deliverables[0].id, slot: 2, round: 1, status: "PENDING", source: "upload", fileName: "w2.mp4" } });
    const lost = await prisma.contentReviewWindow.create({ data: { submissionId: v2.id, videoKey: `${W.id}:w2`, projectId: W.id, enrollmentId: "enr-vp-2", clientId: client.id, round: 1, openedAt: new Date(), deadlineAt: new Date(Date.now() + 3 * 86_400_000), state: "CHANGES_REQUESTED" } });
    await prisma.contentReviewWindow.update({ where: { id: lost.id }, data: { updatedAt: new Date(Date.now() - 5 * 60_000) } });
    await repairPortalRevisionRequests({ now: later });
    c.ok("control: a portal request that lost its decision is still given back (OPEN)", (await prisma.contentReviewWindow.findUniqueOrThrow({ where: { id: lost.id } })).state === "OPEN");

    // =====================================================================
    c.head("6 · Topaz spending limits are the owner's");
    // =====================================================================
    const { saveTopazRules } = await import("@/app/settings/actions");
    const { topazSettings } = await import("@/lib/settings");
    const base = await topazSettings();
    await establishSession(kyle.id);
    const kyleRaise = await saveTopazRules({ ...base, maxCreditsPerMonth: base.maxCreditsPerMonth + 500 });
    c.ok("Kyle raising the monthly credit cap is refused in words", !kyleRaise.ok && /Only Jordan changes the spending limits/.test(kyleRaise.message), kyleRaise.message);
    const kyleVideo = await saveTopazRules({ ...base, maxCreditsPerVideo: base.maxCreditsPerVideo + 50 });
    c.ok("…and the per-video cap", !kyleVideo.ok);
    const kyleOther = await saveTopazRules({ ...base, maxConcurrent: Math.max(1, base.maxConcurrent - 1) });
    const stored = await topazSettings();
    c.ok("Kyle's other settings still save, the caps untouched", kyleOther.ok && stored.maxConcurrent === Math.max(1, base.maxConcurrent - 1) && stored.maxCreditsPerMonth === base.maxCreditsPerMonth && stored.maxCreditsPerVideo === base.maxCreditsPerVideo, kyleOther.message);
    await establishSession(jordan.id);
    const jr = await saveTopazRules({ ...stored, maxCreditsPerMonth: base.maxCreditsPerMonth + 100 });
    c.ok("Jordan changes the cap", jr.ok && (await topazSettings()).maxCreditsPerMonth === base.maxCreditsPerMonth + 100, jr.message);
    const sp = read("src/app/settings/page.tsx");
    const panel = read("src/components/settings/TopazSettingsPanel.tsx");
    c.ok("/settings: the balance and the month's credits reach the owner's browser only (canSeeMoney)", /const money = canSeeMoney\(isOwner \? "OWNER" : null\);/.test(sp) && /balance: money && topazLane\.balance/.test(sp) && /monthCredits: money \? topazLane\.month\.credits : null/.test(sp));
    c.ok("the panel draws them only with showsMoney, the limits locked and the dollar hint hidden for Kyle", /usage\.showsMoney && usage\.monthCredits !== null/.test(panel) && /\{usage\.showsMoney && \(/.test(panel) && (panel.match(/locked=\{!isOwner\}/g) ?? []).length === 5 && /hint=\{isOwner \? "this is the limit that actually bounds the bill\. Your plan includes 400 a month; 900 works out around \$79/.test(panel));

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
