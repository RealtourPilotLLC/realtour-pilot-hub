// W04 listing-final check: isolated database, signed sessions with auth enforced,
// and fake Aryeo listing reads. Client sends and provider writes stay fenced.
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";

let delivered = false;
let listingReads = 0;
let playback = "https://example.test/listing/video-a.mp4";
const v7 = (at: number) => {
  const hex = at.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`;
};
const currentId = v7(Date.now() - 30 * 60_000);
const secondId = v7(Date.now() - 20 * 60_000);
let providerVideoId = currentId;
interceptModule(
  (r) => r === "@/lib/integrations/aryeo" || /[\\/]src[\\/]lib[\\/]integrations[\\/]aryeo(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k === "getListingMedia") return async () => {
        listingReads++;
        return { deliveryStatus: delivered ? "DELIVERED" : "IN_PROGRESS",
        photoCount: 0, videoCount: 3, floorPlanCount: 0, cover: null, images: [], floorPlans: [],
        videos: [
          { id: v7(Date.now() - 3 * 86_400_000), title: "Old video", thumb: null, playback: "https://example.test/old.mp4", download: null, duration: 40 },
          { id: providerVideoId, title: "Current title", thumb: null, playback, download: null, duration: 62 },
          { id: secondId, title: "Second output", thumb: null, playback: "https://example.test/second.mp4", download: null, duration: 45 },
        ] };
      };
      return t[k];
    },
  }),
);
installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5782), env: { AUTH_ENFORCE: "true", APP_SECRET: "w04-isolated-session-secret" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { manualListingCheckReady, FINAL_CHECK_KEYS } = await import("@/lib/finalRendition");
    const { listingFinalChoicesAction, recordListingFinalCheckAction } = await import("@/app/ops/finalRenditionActions");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { signClientSession, CLIENT_COOKIE } = await import("@/lib/auth/clientSession");
    const { resolvePortalViewer } = await import("@/lib/portal");
    // Require reaches the shared next/headers stub; native dynamic import
    // would bypass it and require an actual HTTP request scope.
    const cookieStore = await (createRequire(__filename)("next/headers") as typeof import("next/headers")).cookies();
    const kyle = await prisma.appUser.create({ data: { email: "kyle-w04@example.test", name: "Kyle TEST", role: "ADMIN", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { email: "editor-w04@example.test", name: "Unassigned editor", role: "EDITOR", editorKey: "john", status: "ACTIVE" } });
    const owner = await prisma.appUser.create({ data: { email: "owner-w04@example.test", name: "Owner TEST", role: "OWNER", status: "ACTIVE" } });
    const client = await prisma.client.create({ data: { name: "W04 Listing TEST" } });
    const enrollment = await prisma.contentEnrollment.create({ data: { clientId: client.id, status: "ACTIVE", package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 1 } });
    const clientUser = await prisma.clientUser.create({ data: { email: "client-w04@example.test", name: "Client TEST", status: "ACTIVE" } });
    await prisma.clientMembership.create({ data: { clientUserId: clientUser.id, clientId: client.id, enrollmentId: enrollment.id, role: "OWNER", acceptedAt: new Date() } });
    const clientCookie = await signClientSession({ cu: clientUser.id, email: clientUser.email });
    const clientView = await resolvePortalViewer({ enrollmentId: enrollment.id, cookies: { get: (name) => name === CLIENT_COOKIE ? clientCookie : undefined } });
    c.ok("the client cookie is a real signed owner seat on this isolated program", clientView.ok && clientView.viewer.actor.kind === "CLIENT" && clientView.viewer.actor.clientUserId === clientUser.id);
    const asKyle = async () => {
      cookieStore.delete(CLIENT_COOKIE);
      await setSession({ uid: kyle.id, email: kyle.email, role: kyle.role });
    };
    const deniedActors = [
      { label: "signed client", reason: /Please sign in/, signIn: async () => { await clearSession(); cookieStore.set(CLIENT_COOKIE, clientCookie); } },
      { label: "unassigned editor", reason: /don't have access/, signIn: async () => { cookieStore.delete(CLIENT_COOKIE); await setSession({ uid: editor.id, email: editor.email, role: editor.role }); } },
      { label: "owner preview", reason: /previewing another user/, signIn: async () => { cookieStore.delete(CLIENT_COOKIE); await setSession({ uid: owner.id, email: owner.email, role: owner.role, actingAs: kyle.id }); } },
    ];
    const refused = async (act: () => Promise<{ ok: boolean; message: string } | undefined>, reason: RegExp) => {
      try { const result = await act(); return result?.ok === false && reason.test(result.message); }
      catch (e) { return e instanceof Error && reason.test(e.message); }
    };
    const checkForm = (submissionId: string, mediaId: string, checks: readonly string[] = FINAL_CHECK_KEYS, metadata = false) => {
      const data = new FormData();
      data.set("submissionId", submissionId); data.set("mediaId", mediaId);
      for (const key of checks) data.set(key, "yes");
      if (metadata) { data.set("duration", "62"); data.set("width", "1920"); data.set("height", "1080"); }
      return data;
    };
    await asKyle();
    const project = await prisma.project.create({ data: { clientId: client.id, title: "W04 TEST Address", status: "REVIEW", aryeoListingId: "fake-listing" } });
    const d = await prisma.deliverable.create({ data: { projectId: project.id, type: "VIDEO", quantity: 2 } });
    const cut = await prisma.reviewSubmission.create({ data: { projectId: project.id, deliverableId: d.id, slot: 1, round: 2, status: "APPROVED",
      blobUrl: "https://example.test/source-v2.mp4", contentHash: "hash-v2", assetPath: "/Final/video-v2.mp4", decidedAt: new Date(Date.now() - 86_400_000) } });
    await prisma.deliverableOutput.create({ data: { projectId: project.id, deliverableId: d.id, slot: 1, category: "VIDEO", currentSubmissionId: cut.id, approvedSubmissionId: cut.id } });
    const other = await prisma.reviewSubmission.create({ data: { projectId: project.id, deliverableId: d.id, slot: 2, round: 1, status: "APPROVED",
      blobUrl: "https://example.test/other.mp4", decidedAt: new Date(Date.now() - 86_400_000) } });
    await prisma.deliverableOutput.create({ data: { projectId: project.id, deliverableId: d.id, slot: 2, category: "VIDEO", currentSubmissionId: other.id, approvedSubmissionId: other.id } });
    const choices = await listingFinalChoicesAction(cut.id);
    c.ok("choice excludes older Aryeo video and names the two new media identities", choices.ok && choices.choices.length === 2 && choices.choices.some((x) => x.id === providerVideoId));
    c.ok("unchecked final file cannot be manually delivered", !(await manualListingCheckReady(cut.id)).ok);
    const { markVideoSentAction } = await import("@/app/ops/actions");
    const blockedAction = await markVideoSentAction(cut.id, "not-yet");
    c.ok("staff send action leaves unchecked cut unsent", !blockedAction.ok && !(await prisma.reviewSubmission.findUnique({ where: { id: cut.id } }))?.sentToClientAt);
    c.ok("partial checklist refused without a record", !(await recordListingFinalCheckAction(checkForm(cut.id, providerVideoId, ["identity"]))).ok && await prisma.finalRenditionCheck.count() === 0);
    c.ok("unknown provider video refused", !(await recordListingFinalCheckAction(checkForm(cut.id, "missing"))).ok);
    const saved = await recordListingFinalCheckAction(checkForm(cut.id, providerVideoId, FINAL_CHECK_KEYS, true));
    const row = await prisma.finalRenditionCheck.findFirst({ where: { submissionId: cut.id } });
    c.ok("signed Kyle's exact-version attestation saved with his user id", saved.ok && row?.checkedBy === kyle.name && row.checkedByUserId === kyle.id && row.destinationMediaId === providerVideoId && !!row.sourceFingerprint && !!row.metadataJson);
    c.ok("one video's check cannot certify sibling output", !(await manualListingCheckReady(other.id)).ok);
    c.ok("provider listing not yet delivered blocks manual send", !(await manualListingCheckReady(cut.id)).ok);
    delivered = true;
    c.ok("same provider file on delivered listing allows manual record", (await manualListingCheckReady(cut.id)).ok);
    for (const who of deniedActors) {
      await who.signIn();
      const readsBefore = listingReads;
      c.ok(`${who.label} cannot read staff final-file choices`, await refused(() => listingFinalChoicesAction(cut.id), who.reason));
      c.ok(`${who.label} cannot record a valid final-file check`, await refused(() => recordListingFinalCheckAction(checkForm(cut.id, providerVideoId)), who.reason));
      c.ok(`${who.label} cannot mark the verified delivered cut sent`, await refused(() => markVideoSentAction(cut.id, "not-yet"), who.reason));
      c.ok(`${who.label} leaves check/send records and provider reads unchanged`, await prisma.finalRenditionCheck.count() === 1 && !(await prisma.reviewSubmission.findUnique({ where: { id: cut.id } }))?.sentToClientAt && listingReads === readsBefore);
    }
    await asKyle();
    playback = "https://example.test/replaced.mp4";
    c.ok("changed provider playback invalidates check", !(await manualListingCheckReady(cut.id)).ok);
    playback = "https://example.test/listing/video-a.mp4";
    providerVideoId = v7(Date.now() - 20 * 60_000);
    c.ok("changed provider identity invalidates check", !(await manualListingCheckReady(cut.id)).ok);
    providerVideoId = currentId;
    await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { blobUrl: "https://example.test/source-replaced.mp4" } });
    c.ok("changed source bytes pointer invalidates check", !(await manualListingCheckReady(cut.id)).ok);
    await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { blobUrl: "https://example.test/source-v2.mp4" } });
    const newer = await prisma.reviewSubmission.create({ data: { projectId: project.id, deliverableId: d.id, slot: 1, round: 3, status: "PENDING", blobUrl: "https://example.test/v3.mp4" } });
    c.ok("newer round invalidates old approval", !(await manualListingCheckReady(cut.id)).ok);
    await prisma.reviewSubmission.update({ where: { id: newer.id }, data: { status: "WITHDRAWN", withdrawnAt: new Date() } });
    const { recordUploaded } = await import("@/lib/deliveryUploads");
    const { loadCut, sourceFingerprint } = await import("@/lib/finalRendition");
    await recordUploaded(cut.id, { id: kyle.id, name: kyle.name! }, sourceFingerprint((await loadCut(cut.id))!)!);
    const sent = await markVideoSentAction(cut.id);
    const deliveredCut = await prisma.reviewSubmission.findUnique({ where: { id: cut.id } });
    const deliveredOutput = await prisma.deliverableOutput.findFirst({ where: { projectId: project.id, deliverableId: d.id, slot: 1 } });
    c.ok("verified manual action records this exact cut and output as sent", sent.ok && !!deliveredCut?.sentToClientAt && deliveredOutput?.sentSubmissionId === cut.id);
    const topaz = await prisma.topazJob.create({ data: { projectId: project.id, submissionId: other.id,
      state: "done", finalPath: "/Final/second-1080p.mp4", savedAt: new Date(Date.now() - 60 * 60_000) } });
    const task = await prisma.smartTask.create({ data: { projectId: project.id, taskType: "finish_delivery", title: "Upload second video", assignedKey: "kyle", dedupeKey: `topaz-deliver-${topaz.id}` } });
    await prisma.topazJob.update({ where: { id: topaz.id }, data: { taskId: task.id } });
    const { setSmartTaskStatus } = await import("@/app/actions");
    const blockedTask = await setSmartTaskStatus(task.id, "COMPLETED");
    c.ok("Topaz task completion refuses missing final-file check", blockedTask?.ok === false && (await prisma.smartTask.findUnique({ where: { id: task.id } }))?.status === "OPEN");
    c.ok("second output cannot claim first Aryeo video", !(await recordListingFinalCheckAction(checkForm(other.id, currentId))).ok);
    const checkedSecond = await recordListingFinalCheckAction(checkForm(other.id, secondId));
    for (const who of deniedActors) {
      await who.signIn();
      const readsBefore = listingReads;
      const denied = await refused(() => setSmartTaskStatus(task.id, "COMPLETED"), who.reason);
      c.ok(`${who.label} cannot complete Kyle's checked delivery task`, denied && listingReads === readsBefore && (await prisma.smartTask.findUnique({ where: { id: task.id } }))?.status === "OPEN" && !(await prisma.topazJob.findUnique({ where: { id: topaz.id } }))?.deliveredAt && !(await prisma.reviewSubmission.findUnique({ where: { id: other.id } }))?.sentToClientAt);
    }
    await asKyle();
    await recordUploaded(other.id, { id: kyle.id, name: kyle.name! }, sourceFingerprint((await loadCut(other.id))!)!);
    const taskDone = await setSmartTaskStatus(task.id, "COMPLETED");
    const topazAfter = await prisma.topazJob.findUnique({ where: { id: topaz.id } });
    const taskAfter = await prisma.smartTask.findUnique({ where: { id: task.id } });
    const outputAfter = await prisma.deliverableOutput.findFirst({ where: { projectId: project.id, deliverableId: d.id, slot: 2 } });
    c.ok("verified Topaz task records cut, output, render and task together", checkedSecond.ok && taskDone?.ok === true && !!topazAfter?.deliveredAt && taskAfter?.status === "COMPLETED" && outputAfter?.sentSubmissionId === other.id);
    c.ok("no provider request escaped fake listing", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
