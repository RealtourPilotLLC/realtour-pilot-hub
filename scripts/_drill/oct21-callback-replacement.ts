// ---------------------------------------------------------------------------
// DRILL: a replacement filed by the store's callback alone is announced
// (Oct 21 2026, audit wave 2).
//
// An editor replacing an approved video keeps the reason on the reservation
// (cutReopen.recordReplacementIntent) and the office is told once the version
// exists (audit B10). Only the browser's finish said it, so when the editor
// closed the tab mid-upload and the blob store's upload-completed callback
// filed the version (reviewCuts.finalizeCutUpload), nobody was told. Now the
// caller that files the version says it, exactly once:
//   1. the callback alone: one timeline line, one office bell, the kept
//      reason claimed;
//   2. the browser's finish arriving after it says nothing twice;
//   3. a plain (non-replacement) upload says nothing.
//
// ISOLATION: PGlite via the shared harness; every outbound call is fenced.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6987);
installNextStubs();
const fence = fenceFetch(async () => null);

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const rc = await import("@/lib/reviewCuts");
  const cr = await import("@/lib/cutReopen");
  try {
    const client = await prisma.client.create({ data: { name: "Callback Agent" }, select: { id: true } });
    const job = async (title: string) => {
      const p = await prisma.project.create({ data: { title, clientId: client.id, status: "DELIVERED", deliveredAt: new Date(Date.now() - 3 * 86_400_000) }, select: { id: true } });
      const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Standard Reel", quantity: 1 }, select: { id: true } });
      await prisma.reviewSubmission.create({ data: { projectId: p.id, deliverableId: d.id, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "v1.mp4", decidedAt: new Date(Date.now() - 2 * 86_400_000) } });
      const res = await prisma.reviewSubmission.create({ data: { projectId: p.id, deliverableId: d.id, slot: 1, round: 2, status: "UPLOADING", source: "upload", fileName: "v2.mp4", submittedByKey: "kim", submittedByName: "Kim Miguel" }, select: { id: true } });
      const pathname = `review-cuts/${p.id}/${res.id}/v2-Ab12Cd.mp4`;
      return { projectId: p.id, submissionId: res.id, blob: { url: `https://drillstore.public.blob.vercel-storage.com/${pathname}`, pathname } };
    };
    const lines = (projectId: string) => prisma.activity.count({ where: { projectId, body: { contains: " replaced an approved " } } });
    const bells = (submissionId: string) => prisma.notification.count({ where: { dedupeKey: { startsWith: `cut-reopen-${submissionId}` } } });
    const kept = (submissionId: string) => prisma.appSetting.count({ where: { key: `cut-replacing:${submissionId}` } });

    // =======================================================================
    c.head("1 · the store's callback files a replacement with no browser behind it");
    const R = await job("10 Closed Tab Ln, Royersford, PA");
    await cr.recordReplacementIntent(R.submissionId, { projectId: R.projectId, slot: 1, slotLabel: "Video 1", by: "Kim Miguel", reason: "The client asked for new music", stillApproved: true, sent: false });
    c.ok("(set-up) the reason is kept on the reservation", (await kept(R.submissionId)) === 1);
    const filed = await rc.finalizeCutUpload(R.submissionId, R.blob);
    const row = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: R.submissionId }, select: { status: true } });
    c.ok("the callback files version 2", filed.ok && row.status === "PENDING", `${filed.message} · ${row.status}`);
    c.ok("…and says it: one timeline line naming the editor, the reason and the version", (await lines(R.projectId)) === 1 && !!(await prisma.activity.findFirst({ where: { projectId: R.projectId, body: { contains: 'Kim Miguel replaced an approved Video 1 with version 2: "The client asked for new music"' } } })));
    c.ok("…one bell to the office", (await bells(R.submissionId)) === 1);
    c.ok("…and the kept reason is claimed", (await kept(R.submissionId)) === 0);

    // =======================================================================
    c.head("2 · the browser's finish arriving after it says nothing twice");
    const late = await rc.finalizeCutUpload(R.submissionId, { ...R.blob, size: 77 });
    await cr.announceReplacement(R.submissionId); // the browser path's own call
    c.ok("the late finish answers from the filed row", late.ok, late.message);
    c.ok("…still one timeline line and one bell", (await lines(R.projectId)) === 1 && (await bells(R.submissionId)) === 1, `${await lines(R.projectId)} line(s), ${await bells(R.submissionId)} bell(s)`);

    // =======================================================================
    c.head("3 · a plain upload says nothing");
    const P = await job("11 Plain Upload Pl, Royersford, PA");
    const plain = await rc.finalizeCutUpload(P.submissionId, P.blob);
    c.ok("filed, with no replacement line and no replacement bell", plain.ok && (await lines(P.projectId)) === 0 && (await bells(P.submissionId)) === 0, plain.message);

    c.ok("no call left the drill", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    quiet.restore();
    await stop();
  }
  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
