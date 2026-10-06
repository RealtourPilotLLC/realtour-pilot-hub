// Oct 6 2026: after linking 302 Rita Ct to Erica Walker's July month, pull its
// Aryeo-delivered video into her library (read-only Aryeo GET + PortalVideo upsert),
// then rebuild her program videos. No sends.
import { prisma } from "../../../src/lib/prisma";
const ENR = "cmt7h6b0300059kcj990r34x7", CLIENT = "cmqikslcr00999k9q5809i927", PROJECT = "cmr0ps1ur0001ju04yxias8kx";
(async () => {
  const { syncEnrollmentLibrary } = await import("../../../src/lib/portalLibrary");
  console.log("aryeo library", await syncEnrollmentLibrary(ENR));
  const { syncEnrollmentVideos } = await import("../../../src/lib/contentVideos");
  console.log("videos", await syncEnrollmentVideos({ id: ENR, clientId: CLIENT }));
  console.log(await prisma.portalVideo.findMany({ where: { projectId: PROJECT }, select: { id: true, title: true, monthId: true, download: true } }));
  console.log(await prisma.contentVideo.findMany({ where: { projectId: PROJECT }, select: { id: true, title: true, status: true, kind: true, monthKey: true, deliveredAt: true, releasedToClientAt: true } }));
  await prisma.$disconnect();
})().catch(e => { console.error("ERR", e?.message); process.exit(1); });
