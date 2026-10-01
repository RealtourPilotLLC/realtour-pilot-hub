// A normal named client, signed in by the real one-time-link route, completes
// the later-month written path through the real client/staff server actions.
// Disposable PGlite only. No browser, model, email, booking or media provider.
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import type { VersionParts } from "@/lib/contentScripts";

installNextStubs();
let clientCookie: string | null = null;
// Only request transport is supplied here. The real resolver verifies the
// signed cookie, current membership, program status and rollout on every call.
interceptModule((r) => r === "@/lib/portal" || /[\\/]src[\\/]lib[\\/]portal$/.test(r), (loaded) => {
  const m = loaded as typeof import("@/lib/portal");
  return { ...m, resolvePortalViewer: (input: Parameters<typeof m.resolvePortalViewer>[0]) =>
    m.resolvePortalViewer({ ...input, cookies: input.cookies ?? { get: (name: string) => name === "rtp_client" ? clientCookie ?? undefined : undefined } }) };
});

const ANSWERS: Record<string, string> = {
  audienceProblem: "Sellers who think the first offer is the floor and wait for a better one that never comes.",
  pointOfView: "The first weekend is the whole negotiation, so price for it and you set the terms.",
  talkingPoints: "First, buyers compare competing homes. Second, buyers read days on market as a discount signal. Finally, the right price on day one brings competing offers.",
  evidence: "An example from my own practice is a seller on Oak Street who had three offers by Sunday after pricing for the first weekend.",
  story: "Show two similar homes on the same street, one priced for the first weekend and one sitting for a month.",
  nextAction: "Call me before you book the photographer so we can plan the first weekend together.",
};
const FOLLOW = "A seller in my practice priced for the first weekend and had three offers by Sunday. Buyers compare competing homes, read days on market and decide whether the asking price fits what they can see.";

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5795), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-written-journey-signing-secret" } });
  const fence = fenceFetch();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const portal = await import("@/lib/portal");
    const actions = await import("@/app/portal/actions");
    const staff = await import("@/app/content/actions");
    const { mintLoginLink } = await import("@/lib/portalAccess");
    const { GET } = await import("@/app/portal/auth/[token]/route");
    const { NextRequest } = await import("next/server");
    const { PROGRAM_ROLLOUT_SETTING_KEY, serializeProgramRollout } = await import("@/lib/programRolloutCore");
    const { portalLayoutDecision } = await import("@/lib/portalLayout");
    const { interviewState } = await import("@/lib/contentInterview");
    const { createScriptVersion } = await import("@/lib/contentScripts");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const f = await buildContentMonth(prisma, {
      name: "Grove Written Journey TEST", package: "Starter", videosPerMonth: 1, monthKey: "2026-10", project: false,
      topics: [{ title: "Price for the first weekend", selection: null, source: "client", clientVisible: true }],
      owner: { email: "grove-owner@example.test", name: "Maya Grove" },
    });
    // Normal identity intentionally exercises the named pilot, not TEST bypass.
    await prisma.client.update({ where: { id: f.clientId }, data: { name: "Grove Realty" } });
    const auth = { enrollmentId: f.enrollmentId };
    c.ok("unsigned client action is refused", !(await actions.portalPlanWithoutCall(auth, f.monthId)).ok);
    const now = new Date();
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    await prisma.appSetting.create({ data: { key: PROGRAM_ROLLOUT_SETTING_KEY, value: serializeProgramRollout({
      mode: "PILOT", modeSince: since,
      pilot: { clientIds: [f.clientId], operations: ["portal_sign_in", "portal_layout_v2"], approvedBy: "isolated-fixture", approvedAt: since, expiresAt: new Date(now.getTime() + 86_400_000).toISOString(), joinedAt: { [f.clientId]: since }, note: "Disposable signed-client test" },
    }) } });
    // This only permits local token minting. No request-login-email or sender
    // is called, and the outbound fence has no provider fakes at all.
    await prisma.programAutomation.create({ data: { key: "portal_login_email", enabled: true, enabledBy: "isolated-fixture", enabledAt: now } });
    await prisma.programAutomation.create({ data: { key: "portal_layout_v2", enabled: true, enabledBy: "isolated-fixture", enabledAt: now } });
    const link = await mintLoginLink(f.membershipId!, null);
    const raw = new URL(link.url).pathname.split("/").pop()!;
    const signed = await GET(new NextRequest(link.url), { params: Promise.resolve({ token: raw }) });
    clientCookie = signed.cookies.get("rtp_client")?.value ?? null;
    c.ok("one-time route establishes a signed client cookie", !!clientCookie && signed.status === 303 && new URL(signed.headers.get("location")!).pathname === "/portal/me");
    const reused = await GET(new NextRequest(link.url), { params: Promise.resolve({ token: raw }) });
    c.ok("the same sign-in link cannot establish a second session", !reused.cookies.get("rtp_client") && /portal\/login/.test(reused.headers.get("location") ?? ""));
    const resolved = await portal.resolvePortalViewer({ ...auth, cookies: { get: (name) => name === "rtp_client" ? clientCookie ?? undefined : undefined } });
    if (!resolved.ok) throw new Error(`signed client failed to resolve: ${resolved.reason}`);
    const viewer = resolved.viewer;
    c.ok("the real resolver attributes the normal owner seat", viewer.actor.kind === "CLIENT" && viewer.actor.clientUserId === f.clientUserId && viewer.via === "LOGIN");
    const layout = await portalLayoutDecision(viewer, "Grove Realty", {});
    c.ok("named pilot receives the guided layout", layout.layout === "v2" && layout.why === "PILOT");
    c.ok("first monthly call cannot be bypassed by the written action", !(await actions.portalPlanWithoutCall(auth, f.monthId)).ok);
    const previous = await prisma.contentMonth.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthKey: "2026-09", videosOwed: 1, status: "CLOSED" } });
    await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: previous.id, callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: "MATCHED", scheduledStart: new Date("2026-09-03T17:00:00Z"), scheduledEnd: new Date("2026-09-03T17:30:00Z"), transcriptState: "ANALYZED" } });
    const choice = await actions.portalPlanWithoutCall(auth, f.monthId);
    const chosen = await prisma.contentMonth.findUniqueOrThrow({ where: { id: f.monthId } });
    c.ok("eligible later month saves written choice under the signed client", choice.ok && chosen.planningMode === "WRITTEN" && chosen.planningChosenBy === `client:${f.clientUserId}`, choice.message);
    c.ok("client selects their visible topic", (await actions.portalSelectTopic(auth, f.topicIds[0], f.monthId)).ok);
    const opened = await actions.portalOpenInterview(auth, f.topicIds[0], f.monthId);
    if (!opened.ok || !opened.id) throw new Error(opened.message);
    const iv = opened.id;
    c.ok("opening questions belongs to the client and current month", (await prisma.contentInterview.findUniqueOrThrow({ where: { id: iv } })).startedByClientUserId === f.clientUserId);
    let allSaved = true;
    for (let n = 0; n < 18; n++) {
      const state = await interviewState(iv, { readOnly: true });
      if (!state.nextKey) break;
      const key = state.nextKey;
      const result = await actions.portalAnswerInterview(auth, iv, key, ANSWERS[key] ?? FOLLOW, "TYPED");
      allSaved &&= result.ok;
      if (!result.ok) throw new Error(result.message);
    }
    const submitted = await actions.portalSubmitInterview(auth, iv);
    const saved = await prisma.contentInterview.findUniqueOrThrow({ where: { id: iv } });
    const answers = await prisma.contentInterviewAnswer.findMany({ where: { interviewId: iv } });
    c.ok("saved answers submit through normal signed actions", allSaved && submitted.ok && submitted.status === "SUBMITTED" && saved.submittedByClientUserId === f.clientUserId, submitted.message);
    c.ok("answers retain exact client authorship and survive a fresh reader", answers.length >= 6 && answers.every((a) => a.clientUserId === f.clientUserId) && (await portal.portalInterview(viewer.enrollment, iv))?.status === "SUBMITTED");
    c.ok("sufficient written answers start preparation without a booking", !!(await prisma.contentMonth.findUniqueOrThrow({ where: { id: f.monthId } })).preparationCompletedAt && (await prisma.programSessionRequest.count()) === 0);

    // A human-written draft uses those answer IDs. Real-model drafting is a
    // separate release gate; this checks the exact-version staff/client handoff.
    const owner = await prisma.appUser.create({ data: { name: "Jordan Fixture", email: "owner-written@example.test", role: "OWNER", status: "ACTIVE" } });
    const pillar = await prisma.contentPillar.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, name: "Seller Playbook", status: "ACTIVE" } });
    const parts: VersionParts = { title: "Price for the first weekend", categoryLabel: "Seller Playbook", pillarId: pillar.id,
      hook: "Your first weekend on the market sets the tone.",
      points: [{ role: "re-hook", text: "Buyers compare your home with every nearby option." }, { role: "build-up", text: "Days on market can weaken your negotiating position." }, { role: "payoff", text: "A realistic opening price gives serious buyers a reason to act." }],
      close: "Call me before the photos so we can plan that first weekend." };
    const draft = await createScriptVersion({ enrollmentId: f.enrollmentId, monthId: f.monthId, topicId: f.topicIds[0], interviewId: iv, answerIds: answers.map((a) => a.id), parts, source: "MANUAL", createdBy: owner.email, status: "INTERNAL_REVIEW" });
    c.ok("client session cannot perform staff approval", !(await staff.approveScriptVersionAction(draft.versionId)).ok);
    await setSession({ uid: owner.id, email: owner.email, role: owner.role });
    const approved = await staff.approveScriptVersionAction(draft.versionId);
    c.ok("signed staff approves but does not silently release", approved.ok && !(await prisma.contentScript.findUniqueOrThrow({ where: { id: draft.scriptId } })).sharedVersionId, approved.message);
    const released = await staff.releaseScriptAction(draft.scriptId);
    const share = await prisma.contentScriptRelease.findFirst({ where: { scriptId: draft.scriptId, action: "SHARE" } });
    c.ok("signed staff releases the exact approved version with notice suppressed", released.ok && share?.scriptVersionId === draft.versionId && share.notificationState === "SUPPRESSED", released.message);
    await clearSession();
    const yes = await actions.portalApproveScript(auth, draft.scriptId, draft.versionId);
    const decision = await prisma.contentScriptRelease.findFirst({ where: { scriptId: draft.scriptId, action: "CLIENT_APPROVED" } });
    c.ok("client accepts the exact shared version under their own identity", yes.ok && decision?.scriptVersionId === draft.versionId && decision.actorClientUserId === f.clientUserId, yes.message);
    const original = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: draft.versionId } });
    await setSession({ uid: owner.id, email: owner.email, role: owner.role });
    const next = await createScriptVersion({ scriptId: draft.scriptId, enrollmentId: f.enrollmentId, monthId: f.monthId, topicId: f.topicIds[0], interviewId: iv, answerIds: answers.map((a) => a.id), parts: { ...parts, hook: "A strong first weekend starts before the listing goes live." }, source: "REVISION", basedOnVersionId: draft.versionId, createdBy: owner.email, status: "INTERNAL_REVIEW" });
    c.ok("new staff draft leaves the client's agreed version on the portal", (await prisma.contentScript.findUniqueOrThrow({ where: { id: draft.scriptId } })).sharedVersionId === draft.versionId);
    const nextApproved = await staff.approveScriptVersionAction(next.versionId);
    const nextReleased = await staff.releaseScriptAction(draft.scriptId);
    await clearSession();
    const { scriptDecisionsFor } = await import("@/lib/scriptDecisions");
    const currentDecision = (await scriptDecisionsFor(f.enrollmentId, [draft.scriptId])).get(draft.scriptId);
    c.ok("a deliberate newer release requires its own client decision", nextApproved.ok && nextReleased.ok && currentDecision?.decision === null && !(await actions.portalApproveScript(auth, draft.scriptId, draft.versionId)).ok);
    const nextYes = await actions.portalApproveScript(auth, draft.scriptId, next.versionId);
    c.ok("the signed client can accept the new version without changing old words", nextYes.ok && (await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: draft.versionId } })).body === original.body && (await prisma.contentScriptRelease.count({ where: { scriptId: draft.scriptId, action: "CLIENT_APPROVED", actorClientUserId: f.clientUserId } })) === 2);
    const approvalNotices = await prisma.notification.findMany({ where: { kind: "portal_script_approved" } });
    c.ok("each newly accepted version creates its own office notice", approvalNotices.length === 2 && [draft.versionId, next.versionId].every((id) => approvalNotices.some((n) => n.dedupeKey?.includes(id))));
    const duplicateYes = await actions.portalApproveScript(auth, draft.scriptId, next.versionId);
    c.ok("retrying the same version creates no extra decision or notice", duplicateYes.ok && await prisma.notification.count({ where: { kind: "portal_script_approved" } }) === 2 && await prisma.contentScriptRelease.count({ where: { scriptId: draft.scriptId, action: "CLIENT_APPROVED" } }) === 2);
    await prisma.clientMembership.update({ where: { id: f.membershipId! }, data: { revokedAt: new Date() } });
    const denied = await actions.portalRequestScriptChanges(auth, draft.scriptId, "Change the closing line", next.versionId);
    c.ok("revoking the seat blocks the existing cookie on its next action", !denied.ok && (await prisma.scriptSuggestion.count({ where: { scriptId: draft.scriptId } })) === 0);
    c.ok("journey made no provider request, outbox send or external booking", fence.blocked.length === 0 && fence.faked.length === 0 && (await prisma.outboxMessage.count()) === 0 && (await prisma.programSessionRequest.count()) === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
