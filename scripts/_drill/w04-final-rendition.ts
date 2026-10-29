// W04 listing delivery: isolated database, signed sessions with auth enforced,
// and fake Aryeo listing reads. Client sends and provider writes stay fenced.
// Oct 21 2026: the manual final-file check (listingChoices, recordListingCheck,
// manualListingCheckReady) was deleted with no screen left to reach it; what
// stays checked is the send itself: who may press it, and that it rests on the
// upload receipt.
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";

let delivered = false;
let listingReads = 0;
const playback = "https://example.test/listing/video-a.mp4";
const v7 = (at: number) => {
  const hex = at.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`;
};
const currentId = v7(Date.now() - 30 * 60_000);
const secondId = v7(Date.now() - 20 * 60_000);
const providerVideoId = currentId;
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
      { label: "unassigned editor", reason: /don't have access|can't be completed or moved from your login/, signIn: async () => { cookieStore.delete(CLIENT_COOKIE); await setSession({ uid: editor.id, email: editor.email, role: editor.role }); } },
      { label: "owner preview", reason: /previewing another user/, signIn: async () => { cookieStore.delete(CLIENT_COOKIE); await setSession({ uid: owner.id, email: owner.email, role: owner.role, actingAs: kyle.id }); } },
    ];
    const refused = async (act: () => Promise<{ ok: boolean; message: string } | undefined>, reason: RegExp) => {
      try { const result = await act(); return result?.ok === false && reason.test(result.message); }
      catch (e) { return e instanceof Error && reason.test(e.message); }
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
    const { markVideoSentAction } = await import("@/app/ops/actions");
    const blockedAction = await markVideoSentAction(cut.id, "not-yet");
    c.ok("staff send action leaves unchecked cut unsent", !blockedAction.ok && !(await prisma.reviewSubmission.findUnique({ where: { id: cut.id } }))?.sentToClientAt);
    delivered = true;
    for (const who of deniedActors) {
      await who.signIn();
      const readsBefore = listingReads;
      c.ok(`${who.label} cannot mark the verified delivered cut sent`, await refused(() => markVideoSentAction(cut.id, "not-yet"), who.reason));
      c.ok(`${who.label} leaves send records and provider reads unchanged`, !(await prisma.reviewSubmission.findUnique({ where: { id: cut.id } }))?.sentToClientAt && listingReads === readsBefore);
    }
    await asKyle();
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
    c.ok("verified Topaz task records cut, output, render and task together", taskDone?.ok === true && !!topazAfter?.deliveredAt && taskAfter?.status === "COMPLETED" && outputAfter?.sentSubmissionId === other.id);
    c.ok("no provider request escaped fake listing", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
