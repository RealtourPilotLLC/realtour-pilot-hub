import { prisma } from "@/lib/prisma";
async function main() {
  const users = await prisma.clientUser.count();
  const memberships = await prisma.clientMembership.count();
  const enrollments = await prisma.contentEnrollment.count();
  console.log(`ClientUser rows: ${users} · ClientMembership: ${memberships} · ContentEnrollment: ${enrollments}`);
  const withAccess = await prisma.clientMembership.findMany({ select: { clientId: true } });
  console.log(`clients with ANY portal membership: ${new Set(withAccess.map((m) => m.clientId)).size}`);
  // Approved cuts on content-program jobs — the ones wentOut() currently treats as delivered.
  const cuts = await prisma.reviewSubmission.findMany({
    where: { kind: "video", status: "APPROVED", project: { contentMonthId: { not: null } } },
    select: { id: true, fileName: true, sentToClientAt: true, decidedAt: true,
      project: { select: { title: true, clientId: true, client: { select: { name: true } } } } },
  });
  console.log(`\napproved cuts on content-program jobs: ${cuts.length}`);
  for (const c of cuts) {
    const has = withAccess.some((m) => m.clientId === c.project?.clientId);
    console.log(`  ${has ? "portal access" : "NO portal access"} · ${c.project?.client?.name ?? "?"} · ${String(c.fileName).slice(0, 34)} · markedSent=${c.sentToClientAt ? "yes" : "no"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
