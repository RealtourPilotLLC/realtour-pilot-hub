// READ-ONLY. The 1080p lane's state on every approved-but-unsent cut in the
// candidate population — the difference between "finished and the client cannot
// see it" and "still rendering".
import { prisma } from "@/lib/prisma";
import { laneStillOwesWork } from "@/lib/readyToSend";

async function main() {
  const rows = await prisma.reviewSubmission.findMany({
    where: { status: "APPROVED", sentToClientAt: null },
    select: {
      id: true, round: true, slot: true, fileName: true, decidedAt: true, createdAt: true,
      project: { select: { id: true, title: true, status: true, deliveredAt: true } },
      topazJob: { select: { state: true, finalPath: true, savedAt: true, deliveredAt: true, error: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  console.log(`approved cuts nobody has marked sent: ${rows.length}\n`);
  for (const r of rows) {
    const st = r.topazJob?.state ?? "(no topaz job)";
    const owes = r.topazJob ? laneStillOwesWork(r.topazJob.state) : false;
    console.log(`${(r.project?.title ?? "?").slice(0, 40).padEnd(40)} [${r.project?.status}] r${r.round}/s${r.slot}`);
    console.log(`   approved ${(r.decidedAt ?? r.createdAt).toISOString().slice(0, 16)}  topaz=${st.padEnd(12)} laneStillOwesWork=${owes}  final=${r.topazJob?.finalPath ? "filed" : "none"}  err=${String(r.topazJob?.error ?? "").slice(0, 60)}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
