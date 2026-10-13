// Oct 13 2026 (Jordan): "Go ahead and push them to the portal. I want all videos
// added to all clients portal so it is up to date."
//
// Branding (monthly program) versions that were approved after the portal gate
// and then delivered another way (Aryeo, Oct 5–12) — before portal publication
// worked for clients who hadn't signed up — carry a send stamp but no portal
// release, so the portal hides them. They are released here as what they are:
// videos the client already has (released at the moment they were sent; no
// portal handoff marker, so no review clock and the file is theirs to download).
// Listing videos stay on Aryeo (Jordan, Oct 12: branding → portal, everything
// else → Aryeo). TEST clients and inactive programs are skipped. Nothing is
// sent to anyone.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct6/release-delivered-branding.ts [--apply]
import { prisma } from "@/lib/prisma";

async function main() {
  const apply = process.argv.includes("--apply");
  const cuts = await prisma.reviewSubmission.findMany({
    where: { status: "APPROVED", portalPublicationRequiredAt: { not: null }, clientReleasedAt: null, sentToClientAt: { not: null }, project: { contentMonthId: { not: null }, status: { not: "CANCELLED" } } },
    select: { id: true, fileName: true, round: true, sentToClientAt: true, sentToClientBy: true, project: { select: { clientId: true, contentMonthId: true } } },
  });
  const enrollments = new Map<string, { id: string; clientId: string }>();
  let n = 0;
  for (const c of cuts) {
    const month = await prisma.contentMonth.findUnique({ where: { id: c.project.contentMonthId! }, select: { enrollmentId: true } });
    const e = month ? await prisma.contentEnrollment.findUnique({ where: { id: month.enrollmentId }, select: { id: true, clientId: true, status: true } }) : null;
    const client = await prisma.client.findUnique({ where: { id: c.project.clientId! }, select: { name: true } });
    if (!e || e.clientId !== c.project.clientId || !["ACTIVE", "PAUSED"].includes(e.status) || /TEST/.test(client?.name ?? "")) { console.log(`skip ${client?.name} · ${c.fileName}`); continue; }
    console.log(`${client?.name} · ${c.fileName} v${c.round} · sent ${c.sentToClientAt!.toISOString().slice(0, 10)} by ${c.sentToClientBy}`);
    if (apply) {
      const w = await prisma.reviewSubmission.updateMany({ where: { id: c.id, clientReleasedAt: null }, data: { clientReleasedAt: c.sentToClientAt, clientReleasedBy: "Delivered before portal publication" } });
      n += w.count;
      enrollments.set(e.id, { id: e.id, clientId: e.clientId });
    }
  }
  if (!apply) { console.log(`DRY RUN: ${cuts.length} candidate(s). Re-run with --apply.`); return; }
  const { syncEnrollmentLibrary } = await import("@/lib/contentVideos");
  for (const e of enrollments.values()) {
    const r = await syncEnrollmentLibrary(e, { clearOnSuccess: true });
    console.log(`library ${e.id}: ${r.ok ? "rebuilt" : `failed: ${r.error}`}`);
  }
  console.log(`released ${n}`);
}

main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
