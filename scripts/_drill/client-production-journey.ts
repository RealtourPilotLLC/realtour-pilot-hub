// One normal named-pilot client: onboarding -> written month -> production ->
// revised exact cut -> final portal entitlement. This couples the real actions
// and readers on one fixture rather than rerunning the individual slice drills.
// The earlier completed planning call, externally booked appointment, object
// arrival and finished renderer output are explicit isolated provider inputs.
// No provider booking, AI generation, full media watch or browser claim.
import { createHash } from "node:crypto";
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import type { VersionParts } from "@/lib/contentScripts";

// Oct 5 2026: the sign-in button's POST must prove it came from our own page —
// a same-origin Origin or Sec-Fetch-Site: same-origin, which is what a browser
// sends when the "Continue to your portal" button on that page is pressed (a
// POST with neither is now refused). The drill presses it as a browser would.
const SAME_SITE_PRESS = { "sec-fetch-site": "same-origin" };

const RealDate = Date;
let clock = RealDate.UTC(2026, 9, 1, 14);
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) { return args.length ? Reflect.construct(target, args) : new target(clock); },
  get(target, key, receiver) { return key === "now" ? () => clock : Reflect.get(target, key, receiver); },
}) as DateConstructor;
installNextStubs();
let clientCookie: string | null = null;
interceptModule((r) => r === "@/lib/portal" || /[\\/]src[\\/]lib[\\/]portal$/.test(r), (loaded) => {
  const m = loaded as typeof import("@/lib/portal");
  return { ...m, resolvePortalViewer: (input: Parameters<typeof m.resolvePortalViewer>[0]) =>
    m.resolvePortalViewer({ ...input, cookies: input.cookies ?? { get: (name: string) => name === "rtp_client" ? clientCookie ?? undefined : undefined } }) };
});
const WORDS = "Sellers should prepare for their first weekend before listing. Buyers compare nearby homes, notice days on market and make their best offers when the asking price and the condition make sense. In my own practice a prepared seller on Oak Street had three offers by Sunday. Start with the first weekend plan before booking the photographer.";
const ANSWERS: Record<string, string> = {
  audienceProblem: "Sellers wait for a better offer without preparing for their first weekend.",
  pointOfView: "The first weekend sets the terms, so prepare and price for it before listing.",
  talkingPoints: "Buyers compare nearby homes. Buyers notice days on market. A realistic price and a prepared home bring serious offers.",
  evidence: "A prepared seller on Oak Street had three offers by Sunday in my own practice.",
  story: "Compare two similar homes, one prepared and priced for launch and one sitting for a month.",
  nextAction: "Call me before the photographer so we can plan your first weekend together.",
};
const FINAL_BYTES = "isolated-verified-render-v2";
let expectedFinalPath = "";
const mediaPaths: string[] = [];
/** The verified 1080p files filed in the job's Final folder — Dropbox's metadata
 *  answer for these is a real file proof (id, rev, content hash), which the
 *  portal publication reads (Oct 5 2026). Everything else keeps the old shape. */
const verifiedFinals = new Set<string>();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5964), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-complete-client-journey-secret", BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_drillstore_isolated", DROPBOX_APP_KEY: "isolated-dropbox-key", DROPBOX_APP_SECRET: "isolated-dropbox-secret" } });
  const fence = fenceFetch(async (url, init) => {
    if (url.startsWith("https://geocoding.geo.census.gov/")) return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -75.6055, y: 39.9607 }, matchedAddress: "117 FIRST LANE WEST CHESTER PA" }] } }));
    if (url === "https://api.dropbox.com/oauth2/token") return new Response(JSON.stringify({ access_token: "isolated-dropbox-access" }));
    if (url === "https://api.dropboxapi.com/2/users/get_current_account") return new Response(JSON.stringify({ root_info: { root_namespace_id: "isolated-namespace" } }));
    if (url === "https://api.dropboxapi.com/2/files/list_folder") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
      const rawVideo = /02-RAW-Video/i.test(body.path ?? "");
      return new Response(JSON.stringify({ entries: rawVideo ? [1, 2].map((i) => ({ ".tag": "file", id: `fixture-raw-${i}`, name: `take-${i}.mp4`, path_display: `${body.path}/take-${i}.mp4`, size: 100 })) : [], has_more: false, cursor: "fixture-cursor" }));
    }
    if (url === "https://api.dropboxapi.com/2/files/create_folder_v2") return new Response(JSON.stringify({ metadata: { ".tag": "folder" } }));
    if (url === "https://api.dropboxapi.com/2/files/move_v2") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { to_path?: string };
      return new Response(JSON.stringify({ metadata: { ".tag": "file", path_display: body.to_path } }));
    }
    if (url === "https://api.dropboxapi.com/2/files/save_url") return new Response(JSON.stringify({ ".tag": "complete" }));
    if (url === "https://api.dropboxapi.com/2/files/get_metadata") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
      if (body.path && verifiedFinals.has(body.path)) {
        const hash = createHash("sha256").update(`verified-final:${body.path}`).digest("hex");
        return new Response(JSON.stringify({ ".tag": "file", id: `id:${hash.slice(0, 16)}`, rev: "0fixturefinal1", content_hash: hash, size: FINAL_BYTES.length, name: body.path.split("/").pop(), path_display: body.path, path_lower: body.path.toLowerCase() }));
      }
      return new Response(JSON.stringify({ ".tag": "file", size: 100, content_hash: "fixture-cut-content" }));
    }
    if (url === "https://api.dropboxapi.com/2/files/get_temporary_link") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string };
      mediaPaths.push(body.path ?? "");
      return new Response(JSON.stringify({ metadata: { ".tag": "file", name: "pricing-v2.mp4", path_display: body.path }, link: "https://media.example.test/verified-v2.mp4" }));
    }
    if (url === "https://media.example.test/verified-v2.mp4") return new Response(FINAL_BYTES, { headers: { "content-type": "video/mp4", "content-length": String(FINAL_BYTES.length) } });
    return null;
  });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const portal = await import("@/lib/portal");
    const pa = await import("@/app/portal/actions");
    const staff = await import("@/app/content/actions");
    const review = await import("@/app/review/actions");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { mintLoginLink } = await import("@/lib/portalAccess");
    const loginRoute = await import("@/app/portal/auth/[token]/route");
    const { NextRequest } = await import("next/server");
    const { PROGRAM_ROLLOUT_SETTING_KEY, serializeProgramRollout } = await import("@/lib/programRolloutCore");
    const { createStrategyVersion } = await import("@/lib/contentStrategy");
    const { createScriptVersion } = await import("@/lib/contentScripts");
    const { interviewState } = await import("@/lib/contentInterview");
    const { startEditing, pauseEditing, workStateFor } = await import("@/lib/editorWork");
    const { finalizeUpload } = await import("@/app/upload/actions");
    const { finalizeCutUpload } = await import("@/lib/reviewCuts");
    const { checkContextForSlot } = await import("@/lib/selfCheckStore");
    const { itemsFor } = await import("@/lib/selfCheck");
    const videos = await import("@/lib/contentVideos");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { videoEntitlement, clientCutFiles } = await import("@/lib/cutEntitlement");
    const { mediaToken, mediaScopeOf } = await import("@/lib/portalMedia");
    const download = await import("@/app/api/portal/download/[videoId]/route");
    const stream = await import("@/app/api/review/cut/[id]/stream/route");

    const f = await buildContentMonth(prisma, { name: "Complete Journey TEST", package: "Starter", monthKey: "2026-10", project: false, owner: { email: "maya-production@example.test", name: "Maya Grove" } });
    await prisma.client.update({ where: { id: f.clientId }, data: { name: "Grove Production Realty" } });
    const owner = await prisma.appUser.create({ data: { name: "Jordan", email: "owner-production@example.test", role: "OWNER", status: "ACTIVE" } });
    const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle", email: "kyle-production@example.test", role: "ADMIN" } });
    const kyle = await prisma.appUser.create({ data: { name: kyleTm.name, email: kyleTm.email!, role: "ADMIN", status: "ACTIVE", teamMemberId: kyleTm.id } });
    const jamesTm = await prisma.teamMember.create({ data: { name: "James", email: "james-production@example.test", role: "PHOTOGRAPHER" } });
    const james = await prisma.appUser.create({ data: { name: jamesTm.name, email: jamesTm.email!, role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: jamesTm.id } });
    const shooterTm = await prisma.teamMember.create({ data: { name: "Harrison", email: "harrison-production@example.test", role: "PHOTOGRAPHER" } });
    const shooter = await prisma.appUser.create({ data: { name: shooterTm.name, email: shooterTm.email!, role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: shooterTm.id } });
    const kim = await prisma.appUser.create({ data: { name: "Kim", email: "kim-production@example.test", role: "EDITOR", status: "ACTIVE", editorKey: "kim" } });
    const john = await prisma.appUser.create({ data: { name: "John", email: "john-production@example.test", role: "EDITOR", status: "ACTIVE", editorKey: "john" } });
    const as = (u: typeof owner) => setSession({ uid: u.id, email: u.email, role: u.role });
    await prisma.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ personalBranding: "kim" }) } });
    await prisma.appSetting.create({ data: { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: jamesTm.id, backupReviewerTeamMemberId: kyleTm.id }) } });
    const since = new Date(clock - 864e5).toISOString();
    await prisma.appSetting.create({ data: { key: PROGRAM_ROLLOUT_SETTING_KEY, value: serializeProgramRollout({ mode: "PILOT", modeSince: since, pilot: { clientIds: [f.clientId], operations: ["portal_sign_in"], approvedBy: "isolated-fixture", approvedAt: since, expiresAt: "2026-11-30T23:59:59Z", joinedAt: { [f.clientId]: since }, note: "One disposable normal-client journey" } }) } });
    for (const key of ["portal_login_email"]) await prisma.programAutomation.create({ data: { key, enabled: true, enabledBy: "isolated-fixture", enabledAt: new Date() } });

    c.head("Signed normal client and attributable onboarding");
    const link = await mintLoginLink(f.membershipId!, null);
    const login = await loginRoute.POST(new NextRequest(link.url, { method: "POST", headers: SAME_SITE_PRESS }), { params: Promise.resolve({ token: new URL(link.url).pathname.split("/").pop()! }) });
    clientCookie = login.cookies.get("rtp_client")?.value ?? null;
    const auth = { enrollmentId: f.enrollmentId };
    const r = await portal.resolvePortalViewer({ ...auth, cookies: { get: (name) => name === "rtp_client" ? clientCookie ?? undefined : undefined } });
    if (!r.ok) throw new Error(`Client login: ${r.reason}`);
    const viewer = r.viewer;
    c.ok("one-time sign-in resolves an active named pilot membership", login.status === 303 && viewer.via === "LOGIN" && viewer.actor.kind === "CLIENT" && viewer.actor.clientUserId === f.clientUserId && viewer.enrollment.clientName === "Grove Production Realty");
    await as(owner);
    // A human-authored strategy is the intentional source fixture here. The
    // model/discovery processor is covered by client-call-journey, not rerun.
    const discovery = await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, callType: "BRAND_DISCOVERY", status: "COMPLETED", matchState: "MATCHED", transcriptState: "CONFIRMED", scheduledStart: new Date("2026-09-01T14:00:00Z"), scheduledEnd: new Date("2026-09-01T14:30:00Z") } });
    await prisma.programTranscriptSource.create({ data: { callRecordId: discovery.id, provider: "paste", contentHash: "isolated-production-discovery", text: WORDS, matchState: "CONFIRMED", confirmedBy: owner.email, confirmedAt: new Date(), createdBy: owner.email } });
    const strategy = await createStrategyVersion({ enrollmentId: f.enrollmentId, sourceKind: "discovery_call", callRecordId: discovery.id, createdBy: owner.email, stored: { structureVersion: "LEGACY", document: null, sections: [{ id: "brand", number: 1, order: 1, heading: "Brand direction", text: "Calm, useful advice for West Chester sellers. Help clients prepare for a strong first weekend." }] } });
    const approved = await staff.approveStrategy(strategy.versionId);
    const released = await staff.releaseStrategy(strategy.versionId);
    c.ok("owner approval and release expose the same discovery-pinned strategy without sending", approved.ok && released.ok && (await prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id: strategy.versionId } })).callRecordId === discovery.id && !!(await portal.portalStrategy(viewer.enrollment)) && await prisma.outboxMessage.count() === 0, `${approved.message} / ${released.message}`);
    await as(kyle);
    const pillarResult = await staff.addPillar(f.enrollmentId, "Seller Playbook", "Help sellers prepare", "Pricing and preparation");
    if (!pillarResult.ok) throw new Error(pillarResult.message);
    const pillar = await prisma.contentPillar.findFirstOrThrow({ where: { enrollmentId: f.enrollmentId } });
    const titles = ["Price for the first weekend", "Prepare for the first buyer visit"];
    const topicIds: string[] = [];
    for (const title of titles) {
      const added = await staff.addTopic(f.enrollmentId, { title, source: "ai", concept: WORDS, pillarId: pillar.id });
      if (!added.ok) throw new Error(added.message);
      const topic = await prisma.contentTopic.findFirstOrThrow({ where: { enrollmentId: f.enrollmentId, title } });
      const yes = await staff.topicDecision(topic.id, "APPROVE", "Confirmed against the client's strategy");
      if (!yes.ok) throw new Error(yes.message);
      topicIds.push(topic.id);
    }
    await clearSession();
    const bank = await portal.portalTopics(viewer.enrollment);
    c.ok("Kyle-reviewed bank ideas become client-visible before monthly selection", topicIds.every((id) => bank.groups.flatMap((g) => g.topics).some((t) => t.id === id)) && await prisma.contentTopicSelection.count({ where: { monthId: f.monthId } }) === 0);

    c.head("Later-month written answers and exact script acceptance");
    const previous = await prisma.contentMonth.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthKey: "2026-09", videosOwed: f.videosPerMonth, status: "CLOSED" } });
    await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: previous.id, callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: "MATCHED", transcriptState: "ANALYZED", scheduledStart: new Date("2026-09-03T14:00:00Z"), scheduledEnd: new Date("2026-09-03T14:30:00Z") } });
    const mode = await pa.portalPlanWithoutCall(auth, f.monthId);
    if (!mode.ok) throw new Error(mode.message);
    const scriptIds: string[] = [];
    const versionIds: string[] = [];
    for (const [i, topicId] of topicIds.entries()) {
      const selected = await pa.portalSelectTopic(auth, topicId, f.monthId);
      const opened = await pa.portalOpenInterview(auth, topicId, f.monthId);
      if (!selected.ok || !opened.ok || !opened.id) throw new Error(`${selected.message} / ${opened.message}`);
      for (let n = 0; n < 18; n++) {
        const state = await interviewState(opened.id, { readOnly: true });
        if (!state.nextKey) break;
        const saved = await pa.portalAnswerInterview(auth, opened.id, state.nextKey, ANSWERS[state.nextKey] ?? WORDS, "TYPED");
        if (!saved.ok) throw new Error(saved.message);
      }
      const submitted = await pa.portalSubmitInterview(auth, opened.id);
      if (!submitted.ok) throw new Error(submitted.message);
      const answers = await prisma.contentInterviewAnswer.findMany({ where: { interviewId: opened.id } });
      const parts: VersionParts = { title: titles[i], categoryLabel: pillar.name, pillarId: pillar.id, hook: "Your first weekend sets the tone.", points: [{ role: "re-hook", text: "Buyers compare your home with nearby choices." }, { role: "build-up", text: "Preparation makes the first visit count." }, { role: "payoff", text: "Price realistically and prepare before launch." }], close: "Call me before the photos so we can plan the first weekend." };
      await as(owner);
      const draft = await createScriptVersion({ enrollmentId: f.enrollmentId, monthId: f.monthId, topicId, interviewId: opened.id, answerIds: answers.map((a) => a.id), parts, source: "MANUAL", createdBy: owner.email, status: "INTERNAL_REVIEW" });
      const yes = await staff.approveScriptVersionAction(draft.versionId);
      const share = await staff.releaseScriptAction(draft.scriptId);
      if (!yes.ok || !share.ok) throw new Error(`${yes.message} / ${share.message}`);
      await clearSession();
      const accept = await pa.portalApproveScript(auth, draft.scriptId, draft.versionId);
      if (!accept.ok) throw new Error(accept.message);
      scriptIds.push(draft.scriptId); versionIds.push(draft.versionId);
    }
    const scripts = await prisma.contentScript.findMany({ where: { id: { in: scriptIds } } });
    c.ok("both owed topics carry saved client answers through reviewed exact-version acceptance", scripts.length === f.videosPerMonth && scripts.every((s) => versionIds.includes(s.sharedVersionId!) && s.clientApprovedVersionId === s.sharedVersionId && s.clientApprovedByUserId === f.clientUserId) && await prisma.contentInterview.count({ where: { monthId: f.monthId, submittedByClientUserId: f.clientUserId, status: "SUBMITTED" } }) === f.videosPerMonth);

    c.head("Exact-address client request, Kyle desk handoff and calendar reconciliation");
    const address = await pa.portalSaveSessionPlanAddress(auth, f.monthId, 1, { street: "117 First Lane", city: "West Chester", state: "PA", zip: "19382" });
    if (!address.ok || !address.planId) throw new Error(address.message);
    const plan = await prisma.programSessionPlan.findUniqueOrThrow({ where: { id: address.planId } });
    const shootAt = new Date("2026-10-27T14:00:00Z");
    const request = await pa.portalRequestSession(auth, { monthId: f.monthId, slotISO: shootAt.toISOString(), planId: plan.id, addressVersion: plan.addressVersion, sessionIndex: 1 });
    if (!request.ok || !request.requestId) throw new Error(request.message);
    const asked = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: request.requestId } });
    const desk = await prisma.smartTask.findUnique({ where: { dedupeKey: `content-session-request-${asked.id}` } });
    c.ok("the signed request keeps client/month/address context and gives Kyle a booking task", asked.requestedByClientUserId === f.clientUserId && asked.monthId === f.monthId && asked.planId === plan.id && asked.status === "REQUESTED" && desk?.assignedKey === "kyle" && await prisma.programBookingAttempt.count() === 0, request.message);
    // External appointment input: Kyle books outside this app in the current
    // rollout. We supply the imported row; reconciliation is the real code.
    const project = await prisma.project.create({ data: { clientId: f.clientId, title: "117 First Lane — October content", addressLine: "117 First Lane, West Chester, PA 19382", status: "SCHEDULED", contentMonthId: f.monthId, packageName: "Video Starter", photographerId: shooterTm.id, shootDate: shootAt, aryeoOrderId: "fixture-production-order" } });
    const deliverable = await prisma.deliverable.create({ data: { projectId: project.id, type: "SOCIAL_REEL", label: "Video Starter", productTitle: "Video Starter", quantity: f.videosPerMonth } });
    const appointment = await prisma.appointment.create({ data: { projectId: project.id, aryeoId: "fixture-production-appointment", startAt: shootAt, endAt: new Date(shootAt.getTime() + 2 * 3600_000), durationMin: 120, status: "SCHEDULED", assignedToId: shooterTm.id } });
    const { reconcileSessionRequests } = await import("@/lib/sessionRequests");
    await reconcileSessionRequests();
    const booked = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: asked.id } });
    c.ok("imported calendar evidence confirms that same request and closes Kyle's booking task", booked.status === "CONFIRMED" && booked.projectId === project.id && booked.aryeoAppointmentId === appointment.aryeoId && (await prisma.smartTask.findUniqueOrThrow({ where: { id: desk!.id } })).status === "COMPLETED", JSON.stringify({ status: booked.status, match: booked.matchState }));

    c.head("Assigned photographer hands filmed topic/script context to Kim without starting her");
    clock = RealDate.UTC(2026, 9, 28, 14);
    // The raw files are explicit provider inputs at the existing fetch fence;
    // real folder reads and status/handoff routing consume that evidence.
    await saveSecret("dropbox", "isolated-client-journey-provider-token");
    await as(shooter);
    const handoff = await finalizeUpload(project.id, { editorBrief: "Two useful seller videos, calm delivery.", force: true, cullingConfirmed: true, videoInstructions: "Keep the pricing advice clear. Use the approved scripts and natural pacing.", videosFilmed: 2, filmedTopicIds: topicIds, topicNotes: Object.fromEntries(topicIds.map((id, i) => [id, `Use approved script ${versionIds[i]}; retain the seller example.`])), scriptConfirm: { state: "as-written" }, sawScript: true });
    const outputs = await prisma.deliverableOutput.findMany({ where: { projectId: project.id }, orderBy: { slot: "asc" } });
    const task = await prisma.smartTask.findFirst({ where: { projectId: project.id, taskType: "edit_video", status: { notIn: ["COMPLETED", "CANCELLED"] } } });
    const report = await prisma.contentFilmingReport.findFirst({ where: { projectId: project.id } });
    c.ok("the filmed report binds each existing monthly topic to its own owed output and note", !handoff.blocked && !handoff.topicsPending && report?.state === "APPLIED" && outputs.length === 2 && outputs.every((o, i) => o.topicId === topicIds[i] && o.filmingNote?.includes(versionIds[i])) && task?.assignedKey === "kim", JSON.stringify({ blocked: handoff.blocked, report: report?.state, outputs: outputs.map((o) => ({ slot: o.slot, topic: o.topicId, note: o.filmingNote })), assigned: task?.assignedKey }));
    c.ok("photographer submit and assignment create no automatic editor Start", await prisma.editorWorkItem.count({ where: { projectId: project.id } }) === 0);
    await as(john);
    const wrongStart = await startEditing({ projectId: project.id, requestId: "production-john-start" });
    c.ok("an unassigned signed editor cannot start or reserve this client's output", !wrongStart.ok && !(await review.startCutUpload({ projectId: project.id, deliverableId: deliverable.id, slot: 1, fileName: "unauthorized.mp4", sizeBytes: 10 })).ok && await prisma.reviewSubmission.count({ where: { projectId: project.id } }) === 0, wrongStart.message);
    await as(kim);
    const started = await startEditing({ projectId: project.id, outputId: outputs[0].id, requestId: "production-kim-start" });
    const paused = await pauseEditing({ projectId: project.id, requestId: "production-kim-pause" });
    const pauseState = (await workStateFor([project.id])).get(project.id);
    const resumed = await startEditing({ projectId: project.id, outputId: outputs[0].id, requestId: "production-kim-resume" });
    c.ok("Kim alone explicitly starts, pauses and resumes her assigned work", started.ok && paused.ok && resumed.ok && pauseState?.paused.some((h) => h.editorKey === "kim") === true, `${started.message} / ${paused.message} / ${resumed.message}`);

    c.head("Exact v1 revision, checked v2 and James's creative verdict");
    async function upload(slot: number, name: string, round: number) {
      const ctx = await checkContextForSlot(project.id, { deliverableId: deliverable.id, slot }, { round });
      const check: import("@/lib/selfCheck").SelfCheckInput = { checklistKey: ctx.profile.checklistKey, answers: Object.fromEntries(itemsFor(ctx.profile, { isRevision: ctx.isRevision, openIssueIds: ctx.issues.map((i) => i.id) }).map((item) => [item.key, { answer: "YES" as const }])), issues: { addressed: ctx.issues.map((i) => i.id), notAddressed: {} }, watchedFile: { name, size: 100 } };
      const reservation = await review.startCutUpload({ projectId: project.id, deliverableId: deliverable.id, slot, fileName: name, sizeBytes: 100, width: 1080, height: 1920, selfCheck: check });
      if (!reservation.ok) throw new Error(`Reserve ${name}: ${reservation.message}`);
      const pathname = `${reservation.pathname}-fixture.mp4`;
      const arrived = await finalizeCutUpload(reservation.submissionId, { url: `https://drillstore.public.blob.vercel-storage.com/${pathname}`, pathname, size: 100 });
      if (!arrived.ok) throw new Error(`Arrival ${name}: ${arrived.message}`);
      return reservation.submissionId;
    }
    const v1 = await upload(1, "pricing-v1.mp4", 1);
    const inReview = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: v1 } });
    c.ok("the checked first cut reaches James and settles Kim's active work", inReview.status === "PENDING" && !!inReview.selfCheckedAt && inReview.submittedByKey === "kim" && inReview.reviewerTeamMemberId === jamesTm.id && await prisma.editorWorkItem.count({ where: { projectId: project.id, state: "ACTIVE" } }) === 0);
    await as(james);
    const note = await review.addCutNote({ projectId: project.id, submissionId: v1, body: "Replace the old logo on the last frame.", lane: "EDITOR", kind: "fix", timeSec: 41 });
    const bounce = await review.requestCutChanges(v1);
    if (!note.ok || !bounce.ok) throw new Error(`${note.message} / ${bounce.message}`);
    const issue = await prisma.revisionIssue.findFirstOrThrow({ where: { projectId: project.id, raisedOnSubmissionId: v1 } });
    const revisionTask = await prisma.smartTask.findFirstOrThrow({ where: { projectId: project.id, taskType: "edit_video", status: { notIn: ["COMPLETED", "CANCELLED"] } } });
    c.ok("James's exact-cut note routes back to the same assigned editor without starting work", issue.versionEditorKey === "kim" && issue.timeSec === 41 && revisionTask.assignedKey === "kim" && await prisma.editorWorkItem.count({ where: { projectId: project.id, state: "ACTIVE" } }) === 0);
    await as(kim);
    const revisionStart = await startEditing({ projectId: project.id, outputId: outputs[0].id, requestId: "production-revision-start" });
    if (!revisionStart.ok) throw new Error(revisionStart.message);
    const v2 = await upload(1, "pricing-v2.mp4", 2);
    const sibling = await upload(2, "buyer-visit-v1.mp4", 1);
    await as(james);
    const stale = await review.approveCut(v1);
    const missingTick = await review.approveCut(v2, { verifyIssueIds: [] });
    const secondApproved = await review.approveCut(v2, { verifyIssueIds: [issue.id] });
    const siblingApproved = await review.approveCut(sibling);
    const issueAfter = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: issue.id } });
    c.ok("James approves current v2 and sibling only; stale v1 and unchecked fix remain refused", !stale.ok && !missingTick.ok && secondApproved.ok && siblingApproved.ok && issueAfter.verifiedInSubmissionId === v2 && issueAfter.state === "VERIFIED" && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: v2 } })).decidedByUserId === james.id, JSON.stringify({ stale, missingTick, secondApproved, siblingApproved, verifiedIn: issueAfter.verifiedInSubmissionId, expected: v2 }));

    c.head("Verified final rendition, client decision, entitled download and revocation");
    // An isolated renderer output is the boundary input. No Topaz worker,
    // billing/spend action or real file verification is run in this drill.
    const render = await prisma.topazJob.create({ data: { projectId: project.id, submissionId: v2, state: "processing", fileName: "pricing-v2.mp4" } });
    await clearSession();
    const finishing = (await clientCutFiles([v2])).get(v2);
    const finishingApproval = await pa.portalApproveCut(auth, v2, "NONE");
    c.ok("the client cannot accept the export while its final rendition is processing", finishing?.kind === "finishing" && !finishingApproval.ok, finishingApproval.message);
    // Oct 5 2026 — THE PORTAL PUBLICATION GATE (a60424b, Oct 2): James's
    // approval no longer hands the client the video; its checked 1080p file,
    // filed in the job's own Final folder, is PUBLISHED to the portal (the
    // monthly handoff), and only then can the client decide. The renders are
    // filed where the gate looks (the job's actual Final folder), and the
    // product's own publication runs — the same call the hourly repair makes
    // (repairMonthlyPublications → publishApprovedCutToLibrary).
    const { actualFolderPaths } = await import("@/lib/dropboxFolders");
    const job = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, include: { client: { select: { id: true, name: true } } } });
    const finalFolder = actualFolderPaths(job).finalVideo;
    expectedFinalPath = `${finalFolder}/pricing-v2-FINAL.mp4`;
    const siblingFinalPath = `${finalFolder}/buyer-visit-v1-FINAL.mp4`;
    verifiedFinals.add(expectedFinalPath);
    verifiedFinals.add(siblingFinalPath);
    await prisma.topazJob.update({ where: { id: render.id }, data: { state: "done", finalPath: expectedFinalPath, savedAt: new Date(), outputCheck: "verified", finishedAt: new Date() } });
    await prisma.topazJob.create({ data: { projectId: project.id, submissionId: sibling, state: "done", fileName: "buyer-visit-v1.mp4", finalPath: siblingFinalPath, savedAt: new Date(), outputCheck: "verified", finishedAt: new Date() } });
    const published = await videos.publishApprovedCutToLibrary(v2);
    const siblingPublished = await videos.publishApprovedCutToLibrary(sibling);
    const handoffs = await (await import("@/lib/cutEntitlement")).monthlyPortalHandoffsFor([v2, sibling]);
    c.ok("the verified 1080p files are published to the client's portal by the product's own publication path, each with its handoff marker",
      published.published && siblingPublished.published && handoffs.has(v2) && handoffs.has(sibling) && !!(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: v2 } })).clientReleasedAt,
      JSON.stringify({ published, siblingPublished }));
    await videos.syncEnrollmentLibrary(viewer.enrollment);
    const list = await videos.portalVideoList(viewer.enrollment);
    const clientVideos = await prisma.contentVideo.findMany({ where: { enrollmentId: f.enrollmentId, status: { not: "ARCHIVED" } } });
    const firstVideo = clientVideos.find((v) => v.topicId === topicIds[0]);
    const otherVideo = clientVideos.find((v) => v.topicId === topicIds[1]);
    if (!firstVideo || !otherVideo) throw new Error("The filmed monthly topics did not reach their existing library identities");
    c.ok("both filmed topics remain one logical video each, with exact current cuts and agreed scripts awaiting the client's decision", clientVideos.length === 2 && firstVideo.currentSubmissionId === v2 && firstVideo.approvedSubmissionId === null && otherVideo.currentSubmissionId === sibling && otherVideo.approvedSubmissionId === null && firstVideo.scriptVersionId === versionIds[0] && otherVideo.scriptVersionId === versionIds[1] && list.total === 2, JSON.stringify({ total: list.total, videos: clientVideos.map((v) => ({ id: v.id, topicId: v.topicId, current: v.currentSubmissionId, approved: v.approvedSubmissionId, script: v.scriptVersionId })), topicIds, versionIds, v2, sibling }));
    const before = await videoEntitlement(firstVideo);
    const accepted = await pa.portalApproveCut(auth, v2, "NONE");
    const siblingAccepted = await pa.portalApproveCut(auth, sibling, "NONE");
    const entitlement = await videoEntitlement(firstVideo);
    const decision = await prisma.clientDecision.findFirst({ where: { submissionId: v2, decision: "APPROVE", clientUserId: f.clientUserId } });
    const acceptedVideo = await prisma.contentVideo.findUniqueOrThrow({ where: { id: firstVideo.id } });
    c.ok("client approval binds current v2 and opens its download without certifying stale v1", !before.file && accepted.ok && siblingAccepted.ok && !!decision && acceptedVideo.approvedSubmissionId === v2 && entitlement.file?.submissionId === v2 && await prisma.clientDecision.count({ where: { submissionId: v1, decision: "APPROVE" } }) === 0, accepted.message);
    const scope = mediaScopeOf(viewer);
    const door = await download.GET(new NextRequest(`http://localhost/api/portal/download/${firstVideo.id}?m=${encodeURIComponent(mediaToken(firstVideo.id, scope))}`), { params: Promise.resolve({ videoId: firstVideo.id }) });
    const target = door.headers.get("location");
    if (!target) throw new Error(`Download door ${door.status}: ${await door.text()}`);
    const media = await stream.GET(new NextRequest(target), { params: Promise.resolve({ id: v2 }) });
    c.ok("the entitled download route serves the verified v2 rendition path and fake bytes", door.status === 302 && media.status === 200 && await media.text() === FINAL_BYTES && mediaPaths.length === 1 && mediaPaths[0] === expectedFinalPath);
    const other = await buildContentMonth(prisma, { name: "Other Journey TEST", project: false });
    const foreign = await download.GET(new NextRequest(`http://localhost/api/portal/download/${firstVideo.id}?m=${encodeURIComponent(mediaToken(firstVideo.id, { kind: "membership", id: other.membershipId! }))}`), { params: Promise.resolve({ videoId: firstVideo.id }) });
    await prisma.clientMembership.update({ where: { id: f.membershipId! }, data: { revokedAt: new Date() } });
    const revoked = await download.GET(new NextRequest(`http://localhost/api/portal/download/${firstVideo.id}?m=${encodeURIComponent(mediaToken(firstVideo.id, scope))}`), { params: Promise.resolve({ videoId: firstVideo.id }) });
    const revokedWrite = await pa.portalMarkPosted(auth, firstVideo.id, true);
    c.ok("foreign and revoked memberships cannot download or mutate this client's final", foreign.status === 403 && revoked.status === 403 && !revokedWrite.ok && mediaPaths.length === 1);
    const finalScripts = await prisma.contentScriptVersion.findMany({ where: { id: { in: versionIds } } });
    c.ok("the journey keeps agreed script versions and creates no client sends or provider bookings", finalScripts.length === 2 && finalScripts.every((s) => s.body.includes("Your first weekend sets the tone.")) && await prisma.outboxMessage.count() === 0 && await prisma.programBookingAttempt.count() === 0 && await prisma.programAutomation.count({ where: { enabled: true, key: { notIn: ["portal_login_email"] } } }) === 0 && fence.blocked.length === 0, fence.blocked.join(", "));
    console.log("Boundary evidence: signed action coupling, provider input fixtures, fake final bytes. Normal browser, phone/raw upload, real booking, real AI output, real rendition/watch and production enablement remain unverified.");
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
