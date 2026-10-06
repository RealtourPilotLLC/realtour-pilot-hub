// ---------------------------------------------------------------------------
// DRILL: Oct 5 2026 — video delivery and the client portal, simple and true.
//
//   1  a portal video with no checked 1080p file is never a silent dead end:
//      Kyle's card says exactly why and offers the one button (Run / Retry
//      1080p, Retry publication); "Keep the approved original" is refused for a
//      monthly job; Retry may run after an old keep-original on a portal video
//   2  Topaz problems on a portal video reach Kyle by name (bell + Slack)
//   3  a client whose portal is not live: "Send the Final Dropbox link to
//      <client>, then Mark as sent" — and Mark as sent works for it
//   4  the client sees only versions they were shown, numbered 1, 2, 3
//   5  no "we'll text you" promise after a change request
//   6  notes sent along with an approval become Kyle's task (bell + Slack)
//   7  opening a sign-in link does not spend it; the button's POST does;
//      emailed links last 24 h, typed-email links 15 min
//   8  brand uploads over the platform limit are refused plainly, before
//      sending, with no Retry
//   9  plain client wording (no "Desk-assisted", "Appointments", "photographer")
//  10  a job linked to its content month AFTER approval waits for publication
//
// ISOLATION: PGlite on 127.0.0.1:6595 (this builder's range 6580-6599) via the
// shared harness; every provider fenced; the notify layer is wrapped so Kyle's
// Slack leg is RECORDED, never sent. Nothing reaches a client or a provider.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, portFree } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import type { PortalViewer } from "@/lib/portal";

const PORT = 6595;
const REPO = path.resolve(__dirname, "..", "..");
const src = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

installNextStubs();
// Kyle's Slack leg, answered by a fake Slack: the real staff helper
// (notify.notifyStaffSms) runs end to end and its DM is RECORDED here. A DM
// held for his quiet time is read off its stored row instead (kyleDms below).
const slackPosts: { channel: string; text: string }[] = [];
const fence = fenceFetch((url, init) => {
  if (url !== "https://slack.com/api/chat.postMessage") return null;
  const body = JSON.parse(String(init?.body ?? "{}")) as { channel?: string; text?: string };
  slackPosts.push({ channel: body.channel ?? "", text: body.text ?? "" });
  return new Response(JSON.stringify({ ok: true, ts: "1.1" }), { headers: { "content-type": "application/json" } });
});

async function main() {
  if (!(await portFree(PORT))) throw new Error(`Fixture port ${PORT} is busy; existing process left untouched`);
  const db = await bootDrillDb({ port: PORT, env: { APP_SECRET: "oct5-delivery-portal-isolated" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
    const { streamUrlFor } = await import("@/lib/reviewCuts");
    const cv = await import("@/lib/contentVideos");
    const ce = await import("@/lib/cutEntitlement");
    const cd = await import("@/lib/clientDecisions");
    const rts = await import("@/lib/readyToSend");
    const tj = await import("@/lib/topazJobs");
    const { deliveryReadyMessage } = await import("@/lib/deliveryReadyMessage");
    const { putSetting, topazSettings } = await import("@/lib/settings");
    const actions = await import("@/app/ops/deliveryRecoveryActions");
    const pa = await import("@/lib/portalAccess");
    const { NextRequest } = await import("next/server");

    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("slack", "xoxb-drill-not-a-real-token");
    /** Every DM Kyle got (sent now, or held for his quiet time), in order. */
    const kyleDms = async (): Promise<string[]> => {
      const held = await prisma.appSetting.findMany({ where: { value: { contains: "U-KYLE" } }, select: { value: true } });
      return [...slackPosts.filter((p) => p.channel === "U-KYLE").map((p) => p.text), ...held.map((h) => h.value)];
    };
    const kyle = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@drill.invalid", role: "MANAGER", active: true, slackId: "U-KYLE", payPercent: 0, payFloor: 0 } });
    // Delivery alerts go to the DELIVERY duty owner (Oct 5 wave 2), not to "a name containing Kyle".
    await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", teamMemberId: kyle.id, label: "Kyle Smith", setBy: "drill" } });
    const viewerOf = (f: Awaited<ReturnType<typeof buildContentMonth>>): PortalViewer => ({
      enrollment: { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth },
      actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: "owner@drill.invalid", name: "Ada Owner", membershipId: f.membershipId!, membershipRole: "OWNER" },
      access: "FULL", via: "LOGIN",
    } as PortalViewer);
    let seq = 0;
    const mkCut = async (projectId: string, deliverableId: string | null, slot: number, round: number, data: Record<string, unknown>) => {
      const row = await prisma.reviewSubmission.create({ data: { projectId, deliverableId, slot, round, source: "upload", sizeBytes: 5, fileName: `video${slot}-v${round}.mp4`, createdAt: new Date(Date.now() - 100_000 + seq++), status: "PENDING", ...data }, select: { id: true } });
      await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id), blobUrl: `https://drill.invalid/${row.id}.mp4`, blobPathname: `review-cuts/${row.id}.mp4` } });
      return row.id;
    };
    const now = () => new Date();
    const approvedStamped = () => { const at = now(); return { status: "APPROVED", decidedAt: at, decidedBy: "James", portalPublicationRequiredAt: at }; };

    const A = await buildContentMonth(prisma, { name: "Ada Portal TEST", package: "Accelerator", owner: { email: "ada@realtourpilot.com", name: "Ada Owner" } });
    await ensureOutputsForProject(A.projectId!);
    const viewer = viewerOf(A);

    // =======================================================================
    c.head("4 · the client sees only versions they were shown, numbered 1, 2, 3");
    // =======================================================================
    // Rounds 1 and 2: James sent them back before the client ever saw them.
    for (const round of [1, 2]) await mkCut(A.projectId!, A.deliverableId, 1, round, { status: "CHANGES_REQUESTED", decidedAt: now(), decidedBy: "James" });
    const r3 = await mkCut(A.projectId!, A.deliverableId, 1, 3, { ...approvedStamped(), clientReleasedAt: now() });
    const chain = await ce.cutChainOf(r3);
    c.ok("OLD: the chain the page listed held two internal rounds, and the released one is round 3", chain.length === 3 && chain[2].round === 3 && chain.filter((r) => !cv.cutReleasedAt(r)).length === 2);
    let hist = await cd.cutHistory(viewer, r3);
    c.ok("NEW: history lists only the released version", hist.length === 1 && hist[0].submissionId === r3 && hist[0].isCurrent, JSON.stringify(hist.map((h) => [h.round, h.clientVersion, h.clientState])));
    c.ok("NEW: and calls it Version 1, not Version 3", hist[0]?.clientVersion === 1 && hist[0].round === 3);
    c.ok("no 'Not shared with you' rows reach the client", !hist.some((h) => h.clientState === "NOT_RELEASED"));
    const appr = await cd.approveCut(viewer, r3, "NONE");
    const v1 = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: r3 } });
    const ent = await ce.videoEntitlement((await prisma.contentVideo.findUnique({ where: { id: v1.videoId ?? "" } })) ?? { id: "none", enrollmentId: A.enrollmentId, clientId: A.clientId, monthId: A.monthId, currentSubmissionId: r3, approvedSubmissionId: r3, finalSubmissionId: null });
    c.ok("the download's label uses the client's number too (v1, not v3)", appr.ok && ent.file?.label === "v1 (approved)", `${appr.message} · ${ent.file?.label}`);
    const r4 = await mkCut(A.projectId!, A.deliverableId, 1, 4, { ...approvedStamped(), clientReleasedAt: now() });
    hist = await cd.cutHistory(viewer, r4);
    c.ok("a second released version is Version 2", hist.length === 2 && hist.map((h) => h.clientVersion).join(",") === "1,2", JSON.stringify(hist.map((h) => [h.round, h.clientVersion])));
    const cutReview = src("src/components/portal/CutReview.tsx");
    c.ok("the portal page prints clientVersion, never the editor's round", !/Version \{(current|v)\.round\}|version \{current\.round\}/.test(cutReview) && (cutReview.match(/clientVersion/g) ?? []).length >= 3);

    // =======================================================================
    c.head("5 · after a change request: only promise what will happen");
    // =======================================================================
    await prisma.portalComment.create({ data: { submissionId: r4, projectId: A.projectId!, enrollmentId: A.enrollmentId, timeSec: 3, body: "Brighter intro please", status: "OPEN", clientUserId: A.clientUserId } });
    const asked = await cd.requestChangesOnCut(viewer, r4, "");
    c.ok("reminders off: 'Kyle will reach out when the new version is ready'", asked.ok && /Kyle will reach out when the new version is ready/.test(asked.message), asked.message);
    c.ok("no 'we'll text you' anywhere in the reply", !/text you/i.test(asked.message));
    c.ok("OLD wording is gone from the source", !/we'll text you when the new cut is ready/.test(src("src/lib/clientDecisions.ts")));
    c.ok("reminders off → the hub will not tell the client", (await cd.clientHearsWhenReady(A.clientId)) === false);
    await prisma.programAutomation.upsert({ where: { key: "reminders" }, create: { key: "reminders", enabled: true, enabledAt: now(), enabledBy: "drill" }, update: { enabled: true } });
    c.ok("reminders on and reaching this client → 'We'll let you know' is true", (await cd.clientHearsWhenReady(A.clientId)) === true);
    await prisma.programAutomation.update({ where: { key: "reminders" }, data: { enabled: false } });

    // =======================================================================
    c.head("6 · notes sent along with an approval become Kyle's task");
    // =======================================================================
    const n1 = await mkCut(A.projectId!, A.deliverableId, 2, 1, { ...approvedStamped(), clientReleasedAt: now() });
    await prisma.portalComment.create({ data: { submissionId: n1, projectId: A.projectId!, enrollmentId: A.enrollmentId, timeSec: 12, body: "Love it — use this music again next month", status: "OPEN", clientUserId: A.clientUserId } });
    const tasksBefore = await prisma.smartTask.count();
    c.ok("OLD: nothing on any task list carried the note text", tasksBefore === 0 || (await prisma.smartTask.count({ where: { description: { contains: "use this music again" } } })) === 0);
    const withNotes = await cd.approveCut(viewer, n1, "INCLUDE");
    const notesTask = withNotes.ok ? await prisma.smartTask.findUnique({ where: { dedupeKey: `portal-approval-notes:${withNotes.decisionId}` } }) : null;
    c.ok("approve with 'send them along' writes ONE task owned by Kyle", withNotes.ok && !!notesTask && notesTask.ownerId === kyle.id && notesTask.assignedKey === "kyle", withNotes.message);
    c.ok("…carrying the client's words", !!notesTask?.description?.includes("use this music again next month") && !!notesTask.summary?.includes("use this music again"));
    const dms0 = (await kyleDms()).length;
    await cd.noticeApprovalNotes(withNotes.ok ? withNotes.decisionId : "");
    const dms1 = await kyleDms();
    const bell = await prisma.notification.findFirst({ where: { dedupeKey: `portal-approval-notes-${withNotes.ok ? withNotes.decisionId : ""}-0` } });
    c.ok("Kyle's bell row is addressed to him", bell?.userKey === `tm:${kyle.id}`);
    const notesDm = dms1.slice(dms0).join("\n");
    c.ok("…and his Slack DM carries the notes and the task link", dms1.length === dms0 + 1 && /use this music again/.test(notesDm) && /tasks\?tab=other&task=/.test(notesDm), notesDm.slice(0, 160));
    await cd.noticeApprovalNotes(withNotes.ok ? withNotes.decisionId : "");
    c.ok("a repeat sends nothing again", (await kyleDms()).length === dms1.length && (await prisma.smartTask.count({ where: { dedupeKey: { startsWith: "portal-approval-notes:" } } })) === 1);
    c.ok("the portal action sends the notice after the reply (after())", /after\(notice\)/.test(src("src/app/portal/actions.ts")));

    // =======================================================================
    c.head("1 · a portal video without its checked 1080p file: one reason, one button");
    // =======================================================================
    await putSetting("topaz", { ...(await topazSettings()), enabled: true });
    const p1 = await mkCut(A.projectId!, A.deliverableId, 3, 1, approvedStamped());
    const rowOf = async (id: string) => (await rts.readyToSend({ projectId: A.projectId! })).ready.find((r) => r.submissionId === id);
    let row = await rowOf(p1);
    c.ok("no 1080p pass yet: Run 1080p, blocked, plain reason", row?.portalStep?.action === "run-1080p" && row.portalStep.blocked && /client's portal only gets the checked 1080p file/.test(row.portalStep.says), row?.portalStep?.says);
    c.ok("the file line no longer says the editor's export is the deliverable", !!row && !/is the deliverable/.test(row.file.says), row?.file.says);
    c.ok("Kyle's Slack names the 1080p step and offers no download", !!row && /1080p file needed/.test(deliveryReadyMessage(row, "https://hub.invalid").title) && !/Download:|final check/.test(deliveryReadyMessage(row, "https://hub.invalid").slackDm));
    const ran = await actions.run1080pAction(p1);
    const job1 = await prisma.topazJob.findUnique({ where: { submissionId: p1 } });
    c.ok("Run 1080p answers at once and queues the pass", ran.ok && job1?.state === "queued", ran.message);
    const board1 = await rts.readyToSend({ projectId: A.projectId! });
    c.ok("…the row moves to 'still in the 1080p pass', nothing to send", !board1.ready.some((r) => r.submissionId === p1) && board1.rendering.some((r) => r.submissionId === p1 && r.monthlyProgram === true));
    const listingReason = "This video's audio is uncompressed (PCM), and the 1080p pass loses it — the finished file comes back silent. The editor's own upload is the one to deliver. To put a video through the pass, export it with AAC audio.";
    await prisma.topazJob.update({ where: { id: job1!.id }, data: { state: "skipped", skipReason: listingReason, finishedAt: now() } });
    row = await rowOf(p1);
    c.ok("a skipped pass: Retry 1080p with the real reason", row?.portalStep?.action === "retry-1080p" && /AAC audio/.test(row.portalStep.says), row?.portalStep?.says);
    c.ok("…minus the listing-only 'editor's upload is the one to deliver'", !!row && !/one to deliver/.test(row.portalStep!.says) && !/one to deliver/.test(row.file.why ?? ""));
    const retried = await actions.run1080pAction(p1);
    c.ok("Retry 1080p answers at once; the pass is back in the queue", retried.ok && /Running the 1080p pass again/.test(retried.message) && (await prisma.topazJob.findUniqueOrThrow({ where: { id: job1!.id } })).state === "queued", retried.message);

    // keep-original on a monthly job: refused, and an old one may run again
    await prisma.topazJob.update({ where: { id: job1!.id }, data: { state: "held", heldPath: "/drill/Final Video/unverified/video3-v1 (Topaz - unchecked).mp4", heldAt: now() } });
    const kept = await tj.resolveHeldTopazJob(job1!.id, "use-original", "James");
    c.ok("'Keep the approved original' is refused on a portal video", !kept.ok && /client only gets the checked 1080p file/.test(kept.message) && (await prisma.topazJob.findUniqueOrThrow({ where: { id: job1!.id } })).state === "held", kept.message);
    const heldSrc = src("src/components/ops/HeldRender.tsx");
    c.ok("the held card hides that button for a monthly job", /\{!monthly && \(/.test(heldSrc) && /monthly=\{!!r\.monthlyProgram\}/.test(src("src/components/ops/ReadyToSendCard.tsx")));
    await prisma.topazJob.update({ where: { id: job1!.id }, data: { state: "failed", outputCheck: "resolved-original", heldPath: "/drill/Final Video/superseded/video3-v1 (Topaz - unchecked).mp4", finishedAt: now() } });
    c.ok("an OLD keep-original on a portal video may be retried now", (await tj.retryTopazJobRefusal(job1!.id)) === null);
    row = await rowOf(p1);
    c.ok("…the card says why and offers Retry 1080p", row?.portalStep?.action === "retry-1080p" && /kept the original/.test(row.portalStep.says), row?.portalStep?.says);
    const L = await prisma.project.create({ data: { clientId: A.clientId, title: "12 Listing Rd, Drill, PA", status: "REVIEW" } });
    const lc = await mkCut(L.id, null, 1, 1, { status: "APPROVED", decidedAt: now(), decidedBy: "James" });
    const lj = await prisma.topazJob.create({ data: { projectId: L.id, submissionId: lc, state: "failed", outputCheck: "resolved-original" } });
    c.ok("a listing job keeps its recorded keep-original (unchanged)", /chose the approved original/.test((await tj.retryTopazJobRefusal(lj.id)) ?? ""));

    // verified file, client can sign in: Retry publication, with the last reason
    const p2 = await mkCut(A.projectId!, A.deliverableId, 4, 1, approvedStamped());
    await prisma.topazJob.create({ data: { projectId: A.projectId!, submissionId: p2, state: "done", finalPath: "/drill/Final Video/video4-v1 - FINAL (Topaz).mp4", savedAt: now(), outputCheck: "verified" } });
    row = await rowOf(p2);
    c.ok("checked file, portal live: Retry publication", row?.portalStep?.action === "retry-publication" && !row.portalStep.blocked && !row.portalStep.failed, row?.portalStep?.says);
    const pub = await actions.retryPortalPublicationAction(p2);
    c.ok("Retry publication answers at once", pub.ok && /Publishing to the client's portal now/.test(pub.message), pub.message);
    const failures = await cv.publicationFailuresFor([p2]);
    row = await rowOf(p2);
    c.ok("a publication that cannot land records its reason on the row", failures.has(p2) && row?.portalStep?.failed === true && /Portal publication didn't finish:/.test(row.portalStep.says), row?.portalStep?.says);

    // =======================================================================
    c.head("2 · Topaz problems on a portal video reach Kyle by name");
    // =======================================================================
    const s0 = await topazSettings();
    await putSetting("topaz", { ...s0, enabled: false });
    const p3 = await mkCut(A.projectId!, A.deliverableId, 5, 1, approvedStamped());
    const j3 = await prisma.topazJob.create({ data: { projectId: A.projectId!, submissionId: p3, state: "queued" } });
    const dms2 = (await kyleDms()).length;
    const out3 = await tj.advanceTopazJob(j3.id);
    const skipDms = (await kyleDms()).slice(dms2).join("\n");
    const kyleBell = await prisma.notification.findFirst({ where: { userKey: `tm:${kyle.id}`, dedupeKey: { startsWith: `topaz-skipped-${j3.id}-kyle-` } } });
    c.ok("a skipped pass on a portal video: Kyle's own bell row", out3 === "skipped" && !!kyleBell, out3);
    c.ok("…and his Slack DM, saying it is a portal video and why", /portal video/.test(skipDms) && /switched off in Settings/.test(skipDms) && /#video-review/.test(skipDms), skipDms.slice(0, 160));
    const ownerRow = await prisma.notification.findFirst({ where: { dedupeKey: `topaz-skipped-${j3.id}-0` } });
    c.ok("…the office broadcast becomes owner-only (one bell for Kyle, not two)", ownerRow?.audience === JSON.stringify(["OWNER"]), ownerRow?.audience);
    const lj2c = await mkCut(L.id, null, 2, 1, { status: "APPROVED", decidedAt: now(), decidedBy: "James" });
    const lj2 = await prisma.topazJob.create({ data: { projectId: L.id, submissionId: lj2c, state: "queued" } });
    const dms3 = (await kyleDms()).length;
    await tj.advanceTopazJob(lj2.id);
    c.ok("a listing job's skip stays a bell (its ready DM carries the editor's file)", (await kyleDms()).length === dms3);
    await putSetting("topaz", { ...s0, enabled: true });
    const topazSrc = src("src/lib/topazJobs.ts");
    c.ok("held files and a low Topaz balance are addressed to Kyle too", /dedupeKey: `topaz-held-kyle-/.test(topazSrc) && /dedupeKey: `topaz-low-balance-kyle-/.test(topazSrc));

    // =======================================================================
    c.head("3 · client not live on the portal: send the Final Dropbox link, then Mark as sent");
    // =======================================================================
    const B = await buildContentMonth(prisma, { name: "Bea Outside TEST", package: "Starter", owner: { email: "bea@realtourpilot.com", name: "Bea Owner" } });
    await ensureOutputsForProject(B.projectId!);
    await prisma.client.update({ where: { id: B.clientId }, data: { name: "Bea Outside Realty" } }); // a real client, outside the (closed) rollout
    const b1 = await mkCut(B.projectId!, B.deliverableId, 1, 1, approvedStamped());
    await prisma.topazJob.create({ data: { projectId: B.projectId!, submissionId: b1, state: "done", finalPath: "/drill/B/Final Video/video1-v1 - FINAL (Topaz).mp4", savedAt: now(), outputCheck: "verified" } });
    const bRow = (await rts.readyToSend({ projectId: B.projectId! })).ready.find((r) => r.submissionId === b1);
    c.ok("the card's next step names the client and the two actions", bRow?.portalStep?.action === "send-outside-portal" && bRow.portalStep.says === "Bea Outside Realty's portal isn't live yet. Send the Final Dropbox link to Bea Outside Realty, then Mark as sent.", bRow?.portalStep?.says);
    const bMsg = bRow ? deliveryReadyMessage(bRow, "https://hub.invalid") : null;
    c.ok("Kyle's Slack says the same, with the Final Dropbox file", !!bMsg && /Send the Final Dropbox link to Bea Outside Realty, then Mark as sent/.test(bMsg.slackDm) && /Final Dropbox file:/.test(bMsg.slackDm) && !/final check/.test(bMsg.slackDm), bMsg?.slackDm);
    // A skipped pass on this real client: Kyle is told once, by the Topaz notice —
    // the five-minute delivery sweep does not DM him the same thing again.
    const sOn = await topazSettings();
    await putSetting("topaz", { ...sOn, enabled: false });
    const b3 = await mkCut(B.projectId!, B.deliverableId, 2, 2, approvedStamped());
    const j3b = await prisma.topazJob.create({ data: { projectId: B.projectId!, submissionId: b3, state: "queued" } });
    const dmsB = (await kyleDms()).length;
    await tj.advanceTopazJob(j3b.id);
    await putSetting("topaz", { ...sOn, enabled: true });
    c.ok("the skip reaches Kyle once, by name", (await kyleDms()).length === dmsB + 1);
    const { notifyKyleDeliveryReady } = await import("@/lib/deliveryReadyNotify");
    await notifyKyleDeliveryReady();
    const sweepRows = await prisma.notification.findMany({ where: { userKey: `tm:${kyle.id}`, dedupeKey: { startsWith: "delivery-ready-" } }, select: { title: true, body: true } });
    c.ok("the delivery sweep tells Kyle to send the Dropbox link for the client off the portal", sweepRows.some((r) => r.title.startsWith("Send the Final Dropbox link") && /Send the Final Dropbox link to Bea Outside Realty, then Mark as sent/.test(r.body ?? "")), sweepRows.map((r) => r.title).join(" | "));
    c.ok("…and does not repeat the skipped pass as a second DM", !sweepRows.some((r) => r.title.startsWith("1080p file needed")), sweepRows.map((r) => r.title).join(" | "));
    const oldPress = await rts.markVideoSent(b1, "Kyle");
    c.ok("OLD: the only Mark as sent a portal video had (the portal handoff) refuses here — the dead end", !oldPress.ok && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: b1 } })).sentToClientAt === null, oldPress.message);
    const early = await actions.markSentOutsidePortalAction(b3);
    c.ok("Mark as sent refuses a version with no checked 1080p file", !early.ok && /checked 1080p file isn't ready/.test(early.message), early.message);
    const sameA = await actions.markSentOutsidePortalAction(p2);
    c.ok("…and a client who CAN sign in (publish to their portal instead)", !sameA.ok && /can sign in to the portal now/.test(sameA.message), sameA.message);
    const sent = await actions.markSentOutsidePortalAction(b1);
    const b1Row = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: b1 } });
    c.ok("Mark as sent records Kyle's send", sent.ok && !!b1Row.sentToClientAt && !!b1Row.clientReleasedAt, sent.message);
    c.ok("…as a send outside the portal (no portal handoff marker)", !(await ce.monthlyPortalHandoffsFor([b1])).has(b1));
    c.ok("…and the row leaves Kyle's card", !(await rts.readyToSend({ projectId: B.projectId! })).ready.some((r) => r.submissionId === b1));
    const again = await actions.markSentOutsidePortalAction(b1);
    c.ok("a second press says it is already recorded", again.ok && /Already marked sent/.test(again.message), again.message);

    // =======================================================================
    c.head("10 · a job linked to its month AFTER approval waits for publication");
    // =======================================================================
    const late = await prisma.project.create({ data: { clientId: A.clientId, title: "Late link shoot", status: "REVIEW" } });
    const lateDel = await prisma.deliverable.create({ data: { projectId: late.id, type: "SOCIAL_REEL", label: "Video Accelerator", productTitle: "Video Accelerator", quantity: 1 } });
    // Approved while the job was on no month: approveCut stamps nothing then.
    const lc1 = await mkCut(late.id, lateDel.id, 1, 1, { status: "APPROVED", decidedAt: now(), decidedBy: "James" });
    const raw = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: lc1 } });
    c.ok("OLD: an unstamped approved cut reads as released at its QC time", !!cv.cutReleasedAt(raw) && raw.portalPublicationRequiredAt === null);
    await prisma.project.update({ where: { id: late.id }, data: { contentMonthId: A.monthId } });
    c.ok("NEW: once on a month, it waits for publication (read side)", !!cv.publicationRequiredAt(raw, true) && !cv.cutReleasedAt(cv.withPublicationGate(raw, true)));
    c.ok("…the client file reader holds it as finishing (never the editor's original)", (await ce.clientCutFiles([lc1])).get(lc1)?.kind === "finishing");
    c.ok("…the client's history does not show it", (await cd.cutHistory(viewer, lc1)).length === 0);
    await cv.syncEnrollmentVideos({ id: A.enrollmentId, clientId: A.clientId });
    const stamped = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: lc1 } });
    c.ok("the library sync writes the stamp approveCut would have written", stamped.portalPublicationRequiredAt?.getTime() === raw.decidedAt?.getTime() && !stamped.clientReleasedAt);
    c.ok("…and says so on the job's timeline", (await prisma.activity.count({ where: { projectId: late.id, body: { contains: "linked to its content month" } } })) === 1);
    const vid = stamped.videoId ? await prisma.contentVideo.findUnique({ where: { id: stamped.videoId } }) : null;
    const lateEnt = vid ? await ce.videoEntitlement(vid) : null;
    c.ok("the client is handed no file for it", !!lateEnt && !lateEnt.file, JSON.stringify(lateEnt?.blockedBy));
    await prisma.topazJob.create({ data: { projectId: late.id, submissionId: lc1, state: "done", finalPath: "/drill/late/Final Video/v - FINAL (Topaz).mp4", savedAt: now(), outputCheck: "verified" } });
    c.ok("with its checked 1080p file it is ready to publish (processed, not the original)", (await ce.clientCutFiles([lc1])).get(lc1)?.kind === "processed");
    const unrelated = await prisma.project.create({ data: { clientId: A.clientId, title: "Old monthly", status: "DELIVERED", contentMonthId: A.monthId } });
    const old1 = await mkCut(unrelated.id, null, 1, 1, { status: "APPROVED", decidedAt: new Date("2026-09-20T15:00:00Z"), decidedBy: "James", fileName: "old-monthly.mp4" });
    c.ok("a monthly cut approved before the gate is untouched (still released)", !cv.publicationRequiredAt(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: old1 } }), true) && (await cv.stampImpliedPublicationGates({ projectIds: [unrelated.id] })) === 0);

    // =======================================================================
    c.head("7 · opening a sign-in link does not spend it; the button does");
    // =======================================================================
    const link = await pa.mintLoginLink(A.membershipId!, null, { emailed: true }); // as the reminder and script emails mint it
    const hours = (link.expiresAt.getTime() - Date.now()) / 3_600_000;
    c.ok("an emailed link lasts 24 hours", hours > 23.9 && hours <= 24, hours.toFixed(2));
    c.ok("a typed-email link (15 min) is the one a new request must not cut off", pa.holdsTypedLoginLink(new Date(Date.now() + 10 * 60_000)) && !pa.holdsTypedLoginLink(new Date(Date.now() + 23 * 3_600_000)));
    const raw7 = new URL(link.url).pathname.split("/").pop()!;
    const route = await import("@/app/portal/auth/[token]/route");
    const params = { params: Promise.resolve({ token: raw7 }) };
    const opened = await route.GET(new NextRequest(`${link.url}?next=${encodeURIComponent("/portal/me?tab=topics&iv=abcdefghijkl")}`), params);
    const html = await opened.text();
    c.ok("GET shows 'Continue to your portal' and sets no cookie", opened.status === 200 && html.includes("Continue to your portal") && !opened.cookies.get("rtp_client"));
    c.ok("…carries the safe landing to the button", html.includes('name="next" value="/portal/me?tab=topics&amp;iv=abcdefghijkl"'));
    const scanned = await route.GET(new NextRequest(link.url), { params: Promise.resolve({ token: raw7 }) });
    c.ok("a second open (a mail scanner, a preview) still leaves the link good", scanned.status === 200 && (await pa.peekLoginToken(raw7)).ok);
    const foreign = await route.POST(new NextRequest(link.url, { method: "POST", headers: { origin: "https://evil.invalid", host: "hub.invalid" } }), { params: Promise.resolve({ token: raw7 }) });
    c.ok("a form posted from another site is refused and spends nothing", foreign.status === 303 && /reason=invalid/.test(foreign.headers.get("location") ?? "") && (await pa.peekLoginToken(raw7)).ok);
    // Oct 5 2026 (CSRF fix): the press must PROVE it came from our own page — a
    // same-origin Origin, or Sec-Fetch-Site: same-origin as a browser sends for
    // the button. A POST with neither is refused and spends nothing.
    const bare = await route.POST(new NextRequest(link.url, { method: "POST" }), { params: Promise.resolve({ token: raw7 }) });
    c.ok("a POST with no Origin and no Sec-Fetch-Site is refused and spends nothing", bare.status === 303 && /reason=invalid/.test(bare.headers.get("location") ?? "") && !bare.cookies.get("rtp_client") && (await pa.peekLoginToken(raw7)).ok);
    const pressed = await route.POST(new NextRequest(link.url, { method: "POST", headers: { "sec-fetch-site": "same-origin" }, body: new URLSearchParams({ next: "/portal/me?tab=topics&iv=abcdefghijkl" }) }), { params: Promise.resolve({ token: raw7 }) });
    c.ok("the button's POST signs in and lands where it should", pressed.status === 303 && !!pressed.cookies.get("rtp_client")?.value && new URL(pressed.headers.get("location") ?? "", "https://x.invalid").search === "?tab=topics&iv=abcdefghijkl", pressed.headers.get("location") ?? "");
    const twice = await route.POST(new NextRequest(link.url, { method: "POST", headers: { "sec-fetch-site": "same-origin" } }), { params: Promise.resolve({ token: raw7 }) });
    c.ok("…once: a second press goes to sign-in", /reason=invalid/.test(twice.headers.get("location") ?? "") && !twice.cookies.get("rtp_client"));
    const dead = await route.GET(new NextRequest(link.url), { params: Promise.resolve({ token: raw7 }) });
    c.ok("a spent link opened again goes to the sign-in page", dead.status === 303 && /reason=invalid/.test(dead.headers.get("location") ?? ""));

    // =======================================================================
    c.head("8 · brand uploads over the platform limit: refused plainly, before sending");
    // =======================================================================
    const { portalUploadTooBig, PORTAL_UPLOAD_MAX_BYTES } = await import("@/lib/portalUploadLimit");
    c.ok("the limit is under the platform's 4.5 MB body cap", PORTAL_UPLOAD_MAX_BYTES <= 4.5 * 1024 * 1024 && portalUploadTooBig(3 * 1024 * 1024) === null);
    const tooBig = portalUploadTooBig(6 * 1024 * 1024) ?? "";
    c.ok("the refusal says the size, the limit and who to text", /6\.0 MB/.test(tooBig) && /4 MB/.test(tooBig) && /text Kyle/.test(tooBig), tooBig);
    const upload = await import("@/app/api/portal/upload/route");
    const form = new FormData();
    form.set("token", A.portalToken!);
    form.set("kind", "LOGO");
    form.set("file", new File([new Uint8Array(5 * 1024 * 1024)], "logo.png", { type: "image/png" }));
    const fencedBefore = fence.blocked.length;
    const up = await upload.POST(new NextRequest("http://127.0.0.1/api/portal/upload", { method: "POST", body: form }));
    const upJson = await up.json() as { ok: boolean; tooBig?: boolean; message: string };
    c.ok("the route refuses it with the same plain words, as JSON", up.status === 413 && upJson.tooBig === true && /4 MB/.test(upJson.message), upJson.message);
    c.ok("…before the daily counter or Dropbox", fence.blocked.length === fencedBefore && (await prisma.appSetting.count({ where: { key: { startsWith: "portal-uploads-" } } })) === 0);
    const profile = src("src/components/portal/PortalProfile.tsx");
    c.ok("the page checks the size before sending and shows no Retry for it", /portalUploadTooBig\(file\.size\)/.test(profile) && /u\.state === "failed" && !u\.tooBig/.test(profile) && /xhr\.status === 413/.test(profile));
    c.ok("OLD promise of 25MB is gone", !/25MB/.test(src("src/app/api/portal/upload/route.ts")));

    // =======================================================================
    c.head("9 · plain client words");
    // =======================================================================
    c.ok("no 'Desk-assisted booking' on the scheduler", !/Desk-assisted booking/.test(src("src/components/portal/PortalScheduler.tsx")));
    c.ok("the link says Schedule, as the menu does", !/in Appointments/.test(src("src/components/portal/YourMonth.tsx")) && /Manage filming in Schedule/.test(src("src/components/portal/YourMonth.tsx")));
    c.ok("no 'photographer' for a video session", !/your photographer/.test(src("src/lib/portalHome.ts")));

    c.head("isolation");
    c.ok("nothing left the machine: only the fake Slack answered, every other attempt was fenced", fence.faked.every((u) => u === "https://slack.com/api/chat.postMessage"), `${fence.faked.length} fake Slack, ${fence.blocked.length} fenced`);
    c.ok("no email or text was queued", (await prisma.outboxMessage.count()) === 0);
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
