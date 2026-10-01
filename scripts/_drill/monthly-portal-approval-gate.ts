// @drill-run: engine=postgres needs=tools/realpg timeout=180
// Actual entitlement readers and signed portal stream routes. Disposable
// PostgreSQL only; every file response is fake and all other providers fenced.
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, portFree } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import type { PortalViewer } from "@/lib/portal";

installNextStubs();
let failMarkerRead = false;
interceptModule((name) => name === "@/lib/prisma" || /[\\/]src[\\/]lib[\\/]prisma(\.ts)?$/.test(name), (loaded) => {
  const imported = loaded as { prisma: Record<PropertyKey, unknown> };
  const bind = (value: unknown, self: object) => typeof value === "function" ? value.bind(self) : value;
  return { ...imported, prisma: new Proxy(imported.prisma, {
    get(target, key) {
      const delegate = Reflect.get(target, key, target);
      if (key !== "auditLog") return bind(delegate, target);
      return new Proxy(delegate as Record<PropertyKey, unknown>, {
        get(table, method) {
          const fn = Reflect.get(table, method, table);
          if (method !== "findMany") return bind(fn, table);
          return (...args: unknown[]) => {
            if (failMarkerRead) throw new Error("isolated marker read unavailable");
            return (fn as (...args: unknown[]) => unknown).apply(table, args);
          };
        },
      });
    },
  }) };
});
interceptModule((name) => name === "@/lib/notify" || /[\\/]src[\\/]lib[\\/]notify(\.ts)?$/.test(name), (loaded) => new Proxy(loaded as Record<PropertyKey, unknown>, {
  get: (target, key) => key === "notifyInApp" ? async () => undefined : target[key],
}));
const fence = fenceFetch((url) => url.startsWith("https://fixture.public.blob.vercel-storage.com/")
  ? new Response("bytes", { headers: { "content-type": "video/mp4", "content-length": "5" } }) : null);

async function main() {
  if (!(await portFree(5970))) throw new Error("Fixture port 5970 is busy; existing process left untouched");
  const db = await bootDrillDb({ port: 5970, engine: "postgres", pool: 5, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-monthly-approval-gate" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const ce = await import("@/lib/cutEntitlement");
    const { streamUrlFor } = await import("@/lib/reviewCuts");
    const { syncEnrollmentVideos } = await import("@/lib/contentVideos");
    const { approveCut } = await import("@/lib/clientDecisions");
    const { saveCaptionEdit } = await import("@/lib/postingKit");
    const { mediaToken } = await import("@/lib/portalMedia");
    const { NextRequest } = await import("next/server");
    const stream = await import("@/app/api/review/cut/[id]/stream/route");
    const world = await buildContentMonth(prisma, { name: "Monthly approval gate TEST", package: "Starter", project: { status: "DELIVERED" }, owner: { email: "monthly-gate@example.test", name: "Fixture Client" } });
    const pair = { id: world.enrollmentId, clientId: world.clientId };
    const viewer: PortalViewer = {
      enrollment: { ...pair, clientName: world.clientName, status: "ACTIVE", videosPerMonth: world.videosPerMonth, sessionsPerMonth: world.sessionsPerMonth },
      actor: { kind: "CLIENT", clientUserId: world.clientUserId!, email: "monthly-gate@example.test", name: "Fixture Client", membershipId: world.membershipId!, membershipRole: "OWNER" },
      access: "FULL", via: "LOGIN",
    };
    const marker = (id: string) => ({ id: `monthly-portal-handoff:${id}`, actor: "system", action: "monthly_portal_handoff", target: id, detail: JSON.stringify({ sourceFingerprint: "isolated-fingerprint", finalCheckId: "isolated-check" }) });
    const mk = async (slot: number, round = 1, marked = true, decidedAt = new Date()) => {
      const cut = await prisma.reviewSubmission.create({ data: {
        projectId: world.projectId!, deliverableId: world.deliverableId, slot, round, status: "APPROVED", source: "upload", fileName: `Topic ${slot} v${round}.mp4`, sizeBytes: 5,
        decidedAt, decidedBy: "Office", clientReleasedAt: decidedAt, completedAt: decidedAt, sentToClientAt: decidedAt,
      } });
      await prisma.$transaction(async (tx) => {
        await tx.reviewSubmission.update({ where: { id: cut.id }, data: { assetUrl: streamUrlFor(cut.id), blobUrl: `https://fixture.public.blob.vercel-storage.com/${cut.id}.mp4`, blobPathname: `${cut.id}.mp4`, finalPath: `/Final/${cut.id}.mp4` } });
        if (marked) await tx.auditLog.create({ data: marker(cut.id) });
      });
      await syncEnrollmentVideos(pair);
      return cut.id;
    };
    const video = async (id: string) => {
      const cut = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id } });
      return prisma.contentVideo.findUniqueOrThrow({ where: { id: cut.videoId! } });
    };
    const request = (id: string, download: boolean) => stream.GET(new NextRequest(`http://127.0.0.1${streamUrlFor(id)}?m=${encodeURIComponent(mediaToken(id, { kind: "membership", id: world.membershipId! }))}${download ? "&dl=1" : ""}`), { params: Promise.resolve({ id }) });

    c.head("New monthly availability does not become client approval");
    const v1 = await mk(1), v = await video(v1);
    const initial = await ce.videoEntitlement(v);
    c.ok("marked sent stamp stays awaiting exact client decision", initial.basis === "NONE" && initial.blockedBy === "AWAITING_DECISION" && !initial.file && !initial.captionRef);
    const playback = await request(v1, false), download = await request(v1, true);
    c.ok("signed portal proof can play for review but dl=1 refuses", playback.status === 200 && playback.headers.get("content-disposition")?.startsWith("inline") === true && download.status === 403);
    c.ok("same exact cut is refused by download and caption targets", !(await ce.cutDownloadableFor(pair, v1)) && !(await ce.captionTarget(viewer, v)).ok);
    const caption = await saveCaptionEdit(viewer, v.id, { kind: "CAPTION", body: "A local fixture caption" });
    c.ok("actual caption write guard refuses before saving any draft", !caption.ok && await prisma.contentCaptionDraft.count({ where: { videoId: v.id } }) === 0);
    for (const status of ["PAUSED", "ENDED"]) {
      await prisma.contentEnrollment.update({ where: { id: pair.id }, data: { status } });
      c.ok(`${status}: portal handoff and project DELIVERED still cannot invent external delivery`, (await ce.videoEntitlement(v)).blockedBy === "AWAITING_DECISION" && !(await ce.cutDownloadableFor(pair, v1)));
    }
    await prisma.contentEnrollment.update({ where: { id: pair.id }, data: { status: "ACTIVE" } });
    const approved = await approveCut(viewer, v1, "NONE");
    c.ok("actual client approval unlocks the marked exact cut", approved.ok && (await ce.videoEntitlement(v)).basis === "CLIENT_APPROVED" && await ce.cutDownloadableFor(pair, v1));
    const approvedDownload = await request(v1, true);
    c.ok("signed attachment and caption target agree with exact approval", approvedDownload.status === 200 && approvedDownload.headers.get("content-disposition")?.startsWith("attachment") === true && (await ce.captionTarget(viewer, v)).ok);
    const v2 = await mk(1, 2), updated = await video(v2);
    const waiting = await ce.videoEntitlement(updated);
    c.ok("marked replacement awaits its own decision while approved v1 stays downloadable", waiting.current?.submissionId === v2 && waiting.current.state === "AWAITING" && waiting.file?.submissionId === v1 && waiting.priorVersion === true && !(await ce.cutDownloadableFor(pair, v2)) && await ce.cutDownloadableFor(pair, v1));
    const changes = await prisma.clientDecision.create({ data: { submissionId: v2, projectId: world.projectId!, videoId: updated.id, enrollmentId: pair.id, clientId: pair.clientId, round: 2, decision: "REQUEST_CHANGES", actorLabel: "Fixture Client", contentHash: ce.stableCutIdentity(await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: v2 } })) } });
    await prisma.clientDecision.updateMany({ where: { submissionId: v1, decision: "APPROVE" }, data: { supersededById: changes.id } });
    const requested = await ce.videoEntitlement(updated);
    c.ok("replacement change request preserves the prior approved file and captions only", requested.current?.state === "CHANGES_REQUESTED" && requested.file?.submissionId === v1 && requested.captionRef === v1 && !(await ce.cutDownloadableFor(pair, v2)));

    c.head("Legacy evidence and finishing behavior remain distinct");
    const legacy = await mk(2, 1, false), lv = await video(legacy);
    c.ok("unmarked historic manual send keeps outside-portal entitlement", (await ce.videoEntitlement(lv)).basis === "DELIVERED_OUTSIDE_PORTAL" && await ce.cutDownloadableFor(pair, legacy));
    await prisma.auditLog.create({ data: { ...marker(legacy), target: v2 } });
    c.ok("marker id with another target cannot reclassify a legacy send", (await ce.videoEntitlement(lv)).basis === "DELIVERED_OUTSIDE_PORTAL");
    await prisma.auditLog.update({ where: { id: marker(legacy).id }, data: { target: legacy, action: "unrelated_action" } });
    c.ok("unrelated audit action cannot reclassify a legacy send", (await ce.videoEntitlement(lv)).basis === "DELIVERED_OUTSIDE_PORTAL");
    const preGate = await mk(3, 1, false, new Date("2026-09-01T12:00:00Z"));
    c.ok("pre-gate completed delivery keeps historical entitlement", (await ce.videoEntitlement(await video(preGate))).basis === "HISTORICAL_DELIVERY");
    for (const status of ["PAUSED", "ENDED"]) {
      await prisma.contentEnrollment.update({ where: { id: pair.id }, data: { status } });
      c.ok(`${status}: unmarked external send and previously approved v1 stay available`, await ce.cutDownloadableFor(pair, legacy) && await ce.cutDownloadableFor(pair, v1));
    }
    await prisma.contentEnrollment.update({ where: { id: pair.id }, data: { status: "ACTIVE" } });
    const finishing = await mk(4);
    for (const id of [finishing, legacy, v1]) await prisma.topazJob.create({ data: { projectId: world.projectId!, submissionId: id, state: "queued" } });
    const files = await ce.clientCutFiles([finishing, legacy, v1]);
    c.ok("marked handoff cannot bypass a new finishing hold", files.get(finishing)?.kind === "finishing" && (await request(finishing, false)).status === 409);
    c.ok("external sends and client-approved originals survive later finishing reruns", files.get(legacy)?.kind === "original" && files.get(v1)?.kind === "original");
    const listing = await prisma.project.create({ data: { clientId: pair.clientId, title: "Listing TEST", status: "DELIVERED" } });
    const listingCut = await prisma.reviewSubmission.create({ data: { projectId: listing.id, status: "APPROVED", source: "upload", round: 1, sentToClientAt: new Date() } });
    await prisma.topazJob.create({ data: { projectId: listing.id, submissionId: listingCut.id, state: "queued" } });
    c.ok("listing cuts remain outside the program client-file map", !(await ce.clientCutFiles([listingCut.id])).has(listingCut.id));
    failMarkerRead = true;
    const failedEntitlement = await ce.videoEntitlement(updated).then(() => false, () => true);
    const failedFileRead = await ce.clientCutFiles([finishing]).then(() => false, () => true);
    failMarkerRead = false;
    c.ok("failed marker reads propagate instead of interpreting a new handoff as legacy proof", failedEntitlement && failedFileRead);
    c.ok("only fake media bytes were fetched, with no provider escape or message send", fence.blocked.length === 0 && fence.faked.every((url) => url.startsWith("https://fixture.public.blob.vercel-storage.com/")));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
