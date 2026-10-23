// ---------------------------------------------------------------------------
// DRILL: an approved (even delivered) video reopens for revisions the normal
// way, from every place a client asks (Oct 14 2026).
//
// Jordan: "Sometimes the client will ask for a revision. Right now it makes us
// fill out a revision form. I dont want that. I want the video to be able to
// be re-opened for review / revisions in the review room, or when a client
// requests a change via open phone, just as the normal review process is.
// Same for when someone sends a message or revision request in the content
// program portal. Also revision requests should be at the top of the editor
// brief, and the editor should be notified by the ops hub that it was
// re-opened for revisions."
//
//   1. Review Room: notes on the approved, delivered video, then Reopen for
//      revisions: the cut is back with the editor, the job in Revisions, the
//      editor belled "Reopened for revisions". A stale Request changes is
//      still refused; an older version cannot reopen.
//   2. A client text about the delivered video reopens it, pinned to it, the
//      editor belled; the same text again is one ask; Georgiana's wording
//      reads as video.
//   3. A portal message about the approved video reopens it too.
//   4. A team message: one click (or pick the video when there are several).
//   5. A note resolved and reopened by mistake: its item goes back to open.
//   6. The screens: the button, no form, changes first on the editor brief.
//
// ISOLATION: PGlite via the shared harness; every outbound call fenced.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

installNextStubs();
const fence = fenceFetch((url) => (url.startsWith("https://slack.com/api/") ? new Response(JSON.stringify({ ok: true, channel: "D1", ts: "1.1" }), { headers: { "content-type": "application/json" } }) : null));

async function main() {
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6999), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-reopen" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { setSession } = await import("@/lib/auth/session");
  const read = (p: string) => fs.readFileSync(p, "utf8");
  try {
    const kyle = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle@reopen.test", role: "ADMIN", status: "ACTIVE" } });
    await prisma.appUser.create({ data: { name: "Kim", email: "kim@reopen.test", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
    const kim = await prisma.teamMember.create({ data: { name: "Kim", email: "kim-tm@reopen.test", role: "EDITOR" } });
    await setSession({ uid: kyle.id, email: kyle.email, role: "ADMIN" });

    // A delivered job: one reel, v1 approved and delivered, Kim's.
    const mk = async (name: string, videos = 1) => {
      const f = await buildContentMonth(prisma as never, { name, package: "Starter", videosPerMonth: Math.max(2, videos), project: { status: "DELIVERED" } });
      await prisma.project.update({ where: { id: f.projectId! }, data: { editorId: kim.id, editorManual: true, deliveredAt: new Date("2026-10-14T18:45:00Z") } });
      const cuts = [];
      for (let slot = 1; slot <= videos; slot++) {
        const sub = await prisma.reviewSubmission.create({ data: { projectId: f.projectId!, deliverableId: f.deliverableId!, slot, round: 1, status: "APPROVED", source: "upload", fileName: `reel-${slot}-v1.mov`, assetUrl: `/api/review/cut/x${slot}${name.length}/stream`, decidedBy: "James Livingston", decidedAt: new Date("2026-10-14T16:51:00Z"), submittedByKey: "kim", sentToClientAt: new Date("2026-10-14T18:45:00Z") } });
        const out = await prisma.deliverableOutput.create({ data: { projectId: f.projectId!, deliverableId: f.deliverableId!, slot, category: "SOCIAL_REEL", currentSubmissionId: sub.id, approvedSubmissionId: sub.id, deliveredAt: new Date("2026-10-14T18:45:00Z") } });
        await prisma.reviewSubmission.update({ where: { id: sub.id }, data: { outputId: out.id } });
        cuts.push(sub);
      }
      return { f, cuts };
    };
    const note = (projectId: string, sub: { id: string; assetUrl: string | null }, body: string, timeSec = 52.5) =>
      prisma.mediaNote.create({ data: { projectId, assetUrl: sub.assetUrl ?? `cut:${sub.id}`, assetType: "video", timeSec, lane: "EDITOR", kind: "fix", body, status: "OPEN", authorKey: "owner", authorName: "Jordan Spackman" } });
    const statusOf = async (id: string) => (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id } })).status;
    const actions = await import("@/app/review/actions");

    // ======================================================================
    c.head("1 · the Review Room: notes on the approved video, then Reopen for revisions");
    const A = await mk("Georgiana Reopen TEST");
    const a1 = A.cuts[0];
    await note(A.f.projectId!, a1, "Swap the seated back-deck clip for the standing take.");
    const stale = await actions.requestCutChanges(a1.id);
    c.ok("a stale Request changes (no reopen) is still refused: nothing is un-approved by accident", !stale.ok && /approved a moment ago/.test(stale.message) && (await statusOf(a1.id)) === "APPROVED", stale.message);
    const re = await actions.requestCutChanges(a1.id, { reopen: true });
    c.ok("Reopen for revisions: sent to Kim as the next round", re.ok && /Reopened for revisions/.test(re.message) && /Kim/.test(re.message), re.message);
    c.ok("…the cut is back with the editor", (await statusOf(a1.id)) === "CHANGES_REQUESTED");
    const pA = await prisma.project.findUniqueOrThrow({ where: { id: A.f.projectId! } });
    c.ok("…the delivered job is in Revisions again", pA.status === "REVISION" && !!pA.revisionRequestedAt);
    c.ok("…the timeline says who reopened it and where", !!(await prisma.activity.findFirst({ where: { projectId: A.f.projectId!, body: { startsWith: "Reopened for revisions in the Review Room" } } })));
    const bell = await prisma.notification.findFirst({ where: { userKey: "editor:kim", title: { startsWith: "Reopened for revisions" } } });
    c.ok("…Kim's bell says it was reopened for revisions (bridged to her Slack/text like every editor bell)", !!bell && bell.href === `/edit/${A.f.projectId}`, bell?.title ?? "none");
    const B = await mk("Older Version TEST");
    await prisma.reviewSubmission.create({ data: { projectId: B.f.projectId!, deliverableId: B.f.deliverableId!, slot: 1, round: 2, status: "PENDING", source: "upload", fileName: "reel-1-v2.mov" } });
    await note(B.f.projectId!, B.cuts[0], "Change the music.");
    const old = await actions.requestCutChanges(B.cuts[0].id, { reopen: true });
    c.ok("an older approved version cannot reopen while a newer one is in", !old.ok && /newer version \(v2\)/.test(old.message) && (await statusOf(B.cuts[0].id)) === "APPROVED", old.message);

    // ======================================================================
    c.head("1b · the 1080p pass of a reopened version (Oct 20 2026, audit B1)");
    {
      const { putSetting } = await import("@/lib/settings");
      await putSetting("topaz", { enabled: true, deliverableTypes: ["VIDEO", "SOCIAL_REEL"] });
      const topaz = await import("@/lib/topazJobs");
      // A queued pass (nothing spent) and a finished one with Kyle's upload card.
      const Q = await mk("Queued Pass Reopen TEST");
      const q1 = Q.cuts[0];
      await prisma.reviewSubmission.update({ where: { id: q1.id }, data: { blobUrl: "https://example.test/q1.mov" } });
      const qJob = await prisma.topazJob.create({ data: { submissionId: q1.id, projectId: Q.f.projectId!, state: "queued" } });
      const D = await mk("Done Pass Reopen TEST");
      const d1 = D.cuts[0];
      const dJob = await prisma.topazJob.create({ data: { submissionId: d1.id, projectId: D.f.projectId!, state: "done", finalPath: "/x/Final/reel FINAL (Topaz).mp4", savedAt: new Date() } });
      await prisma.smartTask.create({ data: { taskType: "internal_instruction", title: "Upload the 1080p video to Aryeo — test", source: "system", status: "OPEN", projectId: D.f.projectId!, dedupeKey: `topaz-deliver-${dJob.id}` } });
      await note(Q.f.projectId!, q1, "Trim the intro.");
      await note(D.f.projectId!, d1, "Swap the music.");
      const rq = await actions.requestCutChanges(q1.id, { reopen: true });
      const rd = await actions.requestCutChanges(d1.id, { reopen: true });
      c.ok("both versions reopened", rq.ok && rd.ok, `${rq.message} | ${rd.message}`);
      const qAfter = await prisma.topazJob.findUniqueOrThrow({ where: { id: qJob.id } });
      c.ok("a queued pass on a reopened version stops before anything is spent", qAfter.state === "cancelled" && /reopened for revisions/.test(qAfter.skipReason ?? ""), `${qAfter.state} ${qAfter.skipReason}`);
      const card = await prisma.smartTask.findUniqueOrThrow({ where: { dedupeKey: `topaz-deliver-${dJob.id}` } });
      c.ok("Kyle's upload card for the reopened version closes with the reason", card.status === "CANCELLED" && /reopened for revisions/.test(card.summary ?? ""), `${card.status} ${card.summary}`);
      c.ok("a finished pass is left as it was (the render was paid for)", (await prisma.topazJob.findUniqueOrThrow({ where: { id: dJob.id } })).state === "done");
      // An estimate the reopen could not stop itself: the driver hands it back and stops it.
      const E = await mk("Estimated Pass Reopen TEST");
      const e1 = E.cuts[0];
      const eJob = await prisma.topazJob.create({ data: { submissionId: e1.id, projectId: E.f.projectId!, state: "estimated", requestId: "isolated-request", estimateCredits: 3 } });
      await prisma.reviewSubmission.update({ where: { id: e1.id }, data: { status: "CHANGES_REQUESTED" } });
      const stepped = await topaz.advanceTopazJob(eJob.id);
      const eAfter = await prisma.topazJob.findUniqueOrThrow({ where: { id: eJob.id } });
      c.ok("the driver stops an estimate on a reopened version, with nothing committed", stepped === "cancelled" && eAfter.state === "cancelled" && eAfter.requestId === null && eAfter.acceptedAt === null, `${stepped} ${eAfter.state}`);
      // The same version approved again: its stopped pass comes back to the queue.
      await prisma.reviewSubmission.update({ where: { id: q1.id }, data: { status: "APPROVED" } });
      const again = await topaz.queueTopazRender(q1.id);
      const qBack = await prisma.topazJob.findUniqueOrThrow({ where: { id: qJob.id } });
      c.ok("re-approving the same version re-queues its stopped pass", again.queued && qBack.state === "queued" && qBack.skipReason === null, JSON.stringify(again));
    }

    // ======================================================================
    c.head("2 · a client text about the delivered video reopens it");
    const { raiseRevision, askMedium } = await import("@/lib/comms");
    c.ok("Georgiana's wording reads as video now (it was filed as a photo revision)", askMedium("Also I notice they kept the seated version of me speaking on the back deck and we talked about swapping that with the standing version if my leg couldn't be cropped. Can we swap that frame with the standing version please?") === "video");
    c.ok("…a photo ask still reads as photos", askMedium("Can you brighten the kitchen photos please?") === "photo");
    // Oct 22 2026 (audit H4c, lib/cutReopen soleApprovedVideo): a text names no
    // video, so only a job owing ONE video reopens it unasked. The fixture's
    // Starter month owes two (one cut so far): pinned to one video here, and
    // the two-owed shape is checked just below (filed for a person, nothing
    // guessed).
    const T = await mk("Text Client TEST");
    await prisma.project.update({ where: { id: T.f.projectId! }, data: { videosOwedOverride: 1 } });
    const t1 = T.cuts[0];
    const words = "Hi guys, is it possible to not have the start of the video on this frame of my face? Can we rewind it a bit more";
    const ok1 = await raiseRevision({ projectId: T.f.projectId!, clientId: T.f.clientId, clientName: T.f.clientName, note: words, source: "openphone", threadRef: "op-thread-1", requestedBy: { name: "Georgiana", kind: "TEXT" } });
    const cutT = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: t1.id } });
    c.ok("the text reopens the approved video, James's approval stays on record beside the client's ask", ok1 && cutT.status === "CHANGES_REQUESTED" && cutT.clientRequestedBy === "Georgiana" && cutT.decidedBy === "James Livingston");
    const briefT = await prisma.revisionBrief.findFirst({ where: { projectId: T.f.projectId! }, orderBy: { createdAt: "desc" } });
    c.ok("…the ask is pinned to that video (no guessing which)", briefT?.submissionId === t1.id && !!briefT.outputId);
    const taskT = await prisma.smartTask.findFirst({ where: { projectId: T.f.projectId!, taskType: "revision" } });
    c.ok("…a VIDEO revision on Kim's board", /^Video revision/.test(taskT?.title ?? "") && taskT?.assignedKey === "kim", `${taskT?.title} / ${taskT?.assignedKey}`);
    c.ok("…Kim's bell says it was reopened for revisions", !!(await prisma.notification.findFirst({ where: { userKey: "editor:kim", title: { startsWith: "Reopened for revisions — " }, href: `/edit/${T.f.projectId}` } })));
    c.ok("…and the job is in Revisions", (await prisma.project.findUniqueOrThrow({ where: { id: T.f.projectId! } })).status === "REVISION");
    const briefs0 = await prisma.revisionBrief.count({ where: { projectId: T.f.projectId! } });
    await raiseRevision({ projectId: T.f.projectId!, clientId: T.f.clientId, clientName: T.f.clientName, note: words + " ", source: "openphone", threadRef: "op-thread-1", requestedBy: { name: "Georgiana", kind: "TEXT" } });
    c.ok("the same text sent again is one ask, not a second item", (await prisma.revisionBrief.count({ where: { projectId: T.f.projectId! } })) === briefs0);
    // Two videos owed, one approved: the text could be about either, so nothing reopens and the ask is unpinned.
    const T2 = await mk("Two Owed Text TEST");
    const ok2 = await raiseRevision({ projectId: T2.f.projectId!, clientId: T2.f.clientId, clientName: T2.f.clientName, note: words, source: "openphone", threadRef: "op-thread-2", requestedBy: { name: "Georgiana", kind: "TEXT" } });
    const brief2 = await prisma.revisionBrief.findFirst({ where: { projectId: T2.f.projectId! }, orderBy: { createdAt: "desc" } });
    c.ok("two videos owed, one approved: nothing is guessed (still approved, the ask filed unpinned for a person)", ok2 && (await statusOf(T2.cuts[0].id)) === "APPROVED" && !!brief2 && brief2.submissionId === null, JSON.stringify({ ok2, sub: brief2?.submissionId }));

    // ======================================================================
    c.head("3 · a portal message about the approved video reopens it");
    const P = await mk("Portal Client TEST");
    const p1 = P.cuts[0];
    await prisma.contentVideo.create({ data: { enrollmentId: P.f.enrollmentId, clientId: P.f.clientId, monthId: P.f.monthId, projectId: P.f.projectId!, title: "Market update reel", status: "DELIVERED", approvedSubmissionId: p1.id } as never });
    const pm = await import("@/lib/programMessages");
    type PV = import("@/lib/portal").PortalViewer;
    const viewer = { enrollment: { id: P.f.enrollmentId, clientId: P.f.clientId, clientName: P.f.clientName, status: "ACTIVE", videosPerMonth: 2, sessionsPerMonth: 1 }, actor: { kind: "CLIENT", clientUserId: P.f.clientUserId!, email: "owner@portal.test", name: "Pat Portal", membershipId: P.f.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" } as unknown as PV;
    const sent = await pm.postClientMessage(viewer, { body: "Can we change the music in the video? It's a bit too loud." });
    c.ok("the client is told it went to their editor as a change to that video", sent.ok && /passed this to your editor as a change to/.test(sent.message), sent.message);
    c.ok("…the video reopened, pinned, a portal-message revision", (await statusOf(p1.id)) === "CHANGES_REQUESTED" && !!(await prisma.revisionBrief.findFirst({ where: { projectId: P.f.projectId!, source: "portal_message", submissionId: p1.id } })));
    c.ok("…the program video reads 'editing' and no longer claims the approval", (await prisma.contentVideo.findFirstOrThrow({ where: { enrollmentId: P.f.enrollmentId } })).approvedSubmissionId === null);
    c.ok("…and it is still a message the office answers", (await prisma.programMessage.count({ where: { enrollmentId: P.f.enrollmentId, authorKind: "CLIENT" } })) === 1);
    const chat = await pm.postClientMessage(viewer, { body: "Thanks so much, see you next week!" });
    c.ok("a plain message stays a message", chat.ok && !/editor/.test(chat.message));

    // ======================================================================
    c.head("4 · a team message: one click (pick the video when there are several)");
    const M = await mk("Team Message TEST", 2);
    const { messageToRevision } = await import("@/app/review/staffRevisionActions");
    const msg = await prisma.projectMessage.create({ data: { projectId: M.f.projectId!, authorName: "Kyle", body: "Client called: make the logo bigger at the end." } });
    const pick = await messageToRevision(M.f.projectId!, msg.id);
    c.ok("two approved videos: it asks which, and nothing reopens yet", !pick.ok && (pick.choices ?? []).length === 2 && (await statusOf(M.cuts[0].id)) === "APPROVED" && (await statusOf(M.cuts[1].id)) === "APPROVED", JSON.stringify(pick));
    const sentM = await messageToRevision(M.f.projectId!, msg.id, M.cuts[1].id);
    c.ok("picked: that video reopens and goes to Kim", sentM.ok && /reopened for revisions and sent to Kim/.test(sentM.message) && (await statusOf(M.cuts[1].id)) === "CHANGES_REQUESTED" && (await statusOf(M.cuts[0].id)) === "APPROVED", sentM.message);

    // ======================================================================
    c.head("5 · a note resolved and reopened by mistake");
    const { ingestReviewNote, mirrorNoteStatus } = await import("@/lib/revisionIssues");
    const nn = await note(A.f.projectId!, a1, "Back the first frame up a bit.", 0);
    const issueId = await ingestReviewNote(nn.id);
    await mirrorNoteStatus(nn.id, "RESOLVED", { name: "Jordan" });
    c.ok("resolved: the item reads verified", (await prisma.revisionIssue.findUniqueOrThrow({ where: { id: issueId! } })).state === "VERIFIED");
    await mirrorNoteStatus(nn.id, "OPEN", { name: "Jordan" });
    c.ok("reopened 12 s later: the item is open again (it stayed closed before)", (await prisma.revisionIssue.findUniqueOrThrow({ where: { id: issueId! } })).state === "OPEN");

    // ======================================================================
    c.head("6 · the screens");
    const panel = read("src/components/review/CutReviewPanel.tsx");
    c.ok("the Review Room has Reopen for revisions on an approved video, and no revision form", /Reopen for revisions/.test(panel) && /requestCutChanges\(submission\.id, \{ reopen: true \}\)/.test(panel) && !/StaffCutRevisionForm/.test(panel));
    c.ok("a team message is one click, no form", /messageToRevision\(projectId, messageId/.test(read("src/components/project/ProjectMessages.tsx")) && !/StaffCutRevisionForm/.test(read("src/components/project/ProjectMessages.tsx")));
    const page = read("src/app/edit/[id]/page.tsx");
    c.ok("the editor brief puts Changes to make right under the header", page.indexOf('data-brief-section="header"') < page.indexOf('data-brief-section="changes"') && page.indexOf('data-brief-section="changes"') < page.indexOf('data-brief-section="make"'));
    const packet = read("src/lib/editorPacket.ts");
    c.ok("the editor's PDF packet puts the open revision requests first", packet.indexOf('heading("Open revision requests")') < packet.indexOf('heading("Where the files are")'));
    c.ok("the portal lets a client reopen an approved video with notes and a change request", /const reopenable = approved/.test(read("src/components/portal/CutReview.tsx")));

    c.head("isolation");
    c.ok("only Slack was answered; nothing else left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
