// READ-ONLY production probe. Sizes the two findings before anything is changed:
//   R03 — outputs whose historical deliveredAt outranks a NEWER, unsent round.
//   R06 — jobs that owe video and have no (or a stale) set of output rows, and
//         how many rows carry an owner / a deadline at all.
import { prisma } from "@/lib/prisma";

async function main() {
  const outputs = await prisma.deliverableOutput.count();
  const withOwner = await prisma.deliverableOutput.count({ where: { ownerKey: { not: null } } });
  const withPromise = await prisma.deliverableOutput.count({ where: { promisedAt: { not: null } } });
  const withTarget = await prisma.deliverableOutput.count({ where: { targetAt: { not: null } } });
  console.log(`DeliverableOutput rows: ${outputs} — ownerKey ${withOwner}, promisedAt ${withPromise}, targetAt ${withTarget}`);

  // R06: jobs that owe video, and whether they have rows.
  const owing = await prisma.project.findMany({
    where: {
      status: { notIn: ["CANCELLED"] },
      deliverables: { some: { removedFromOrderAt: null, type: { in: ["VIDEO", "SOCIAL_REEL"] } } },
    },
    select: { id: true, title: true, status: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const haveRows = new Set((await prisma.deliverableOutput.groupBy({ by: ["projectId"] })).map((g) => g.projectId));
  const bare = owing.filter((p) => !haveRows.has(p.id));
  console.log(`\njobs owing video: ${owing.length} — with NO output row at all: ${bare.length}`);
  for (const p of bare.slice(0, 15)) console.log(`   ${p.createdAt.toISOString().slice(0, 10)} ${p.title} [${p.status}]`);

  // R03: a round sent, and a LATER round that is not sent.
  const rounds = await prisma.reviewSubmission.findMany({
    where: { deliverableId: { not: null }, withdrawnAt: null, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } },
    orderBy: { round: "asc" },
    select: { projectId: true, deliverableId: true, slot: true, round: true, status: true, sentToClientAt: true },
  });
  const byKey = new Map<string, typeof rounds>();
  for (const r of rounds) {
    const k = `${r.projectId}|${r.deliverableId}:${r.slot ?? 1}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  let hits = 0;
  for (const [k, rs] of byKey) {
    const latest = rs[rs.length - 1];
    const everSent = rs.some((r) => r.sentToClientAt);
    if (everSent && !latest.sentToClientAt) {
      hits++;
      console.log(`\nR03 shape LIVE: ${k} — latest v${latest.round} ${latest.status}, not sent; an earlier round was`);
    }
  }
  console.log(`\nslots whose newest round is unsent after an earlier send: ${hits}`);

  // …and the same question asked of the STORED stamp, which is what the view reads.
  const stamped = await prisma.deliverableOutput.count({ where: { deliveredAt: { not: null } } });
  console.log(`outputs carrying a deliveredAt stamp: ${stamped}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
