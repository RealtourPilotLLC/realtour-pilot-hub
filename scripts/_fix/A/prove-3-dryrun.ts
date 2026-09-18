// MINOR 3 — BLAST RADIUS, READ-ONLY. refreshOutputsForProject stopped being
// write-once, so before it runs against 922 live rows: what would it change?
// This is refreshOutputsForProject's new arithmetic, with the update() removed.
// No writes.
import { prisma } from "@/lib/prisma";
import { slotKeyOf } from "@/lib/reviewCuts";

const NOT_A_ROUND = ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"];

async function main() {
  const outputs = await prisma.deliverableOutput.findMany({
    select: {
      id: true, projectId: true, deliverableId: true, slot: true, reviewReadyAt: true, approvedAt: true,
      deliveredAt: true, currentSubmissionId: true, approvedSubmissionId: true, sentSubmissionId: true,
    },
  });
  const rounds = await prisma.reviewSubmission.findMany({
    where: { deliverableId: { not: null }, withdrawnAt: null, status: { notIn: NOT_A_ROUND } },
    orderBy: { round: "asc" },
    select: { id: true, projectId: true, deliverableId: true, slot: true, status: true, createdAt: true, decidedAt: true, sentToClientAt: true },
  });
  const byKey = new Map<string, typeof rounds>();
  for (const r of rounds) {
    const k = `${r.projectId}|${slotKeyOf(r.deliverableId!, r.slot)}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }

  const tally: Record<string, number> = {};
  const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  const examples: string[] = [];

  for (const o of outputs) {
    const rs = byKey.get(`${o.projectId}|${slotKeyOf(o.deliverableId, o.slot)}`) ?? [];
    const latest = rs[rs.length - 1] ?? null;
    const approved = [...rs].reverse().find((r) => r.status === "APPROVED") ?? null;
    const sent = [...rs].reverse().find((r) => r.sentToClientAt) ?? null;
    const readyAt = rs[0]?.createdAt ?? null;
    const approvedAt = approved ? approved.decidedAt ?? approved.createdAt : null;

    if (o.currentSubmissionId !== (latest?.id ?? null)) bump(latest ? "currentSubmissionId → another round" : "currentSubmissionId → null");
    if ((o.reviewReadyAt?.getTime() ?? null) !== (readyAt?.getTime() ?? null)) bump(readyAt ? "reviewReadyAt → another time" : "reviewReadyAt → null");
    if (o.approvedSubmissionId !== (approved?.id ?? null)) bump(approved ? "approvedSubmissionId → another round" : "approvedSubmissionId → null");
    if ((o.approvedAt?.getTime() ?? null) !== (approvedAt?.getTime() ?? null)) {
      bump(approvedAt ? "approvedAt → another time" : "approvedAt → null (RETRACTION)");
      if (approvedAt === null && o.approvedAt && examples.length < 10) examples.push(`  retract approvedAt on ${o.deliverableId}:${o.slot} (${o.projectId}) — ${rs.length} live rounds`);
    }
    if (!(sent && !o.deliveredAt) && o.sentSubmissionId && !rs.some((r) => r.id === o.sentSubmissionId)) bump("sentSubmissionId → repaired (deliveredAt kept)");
  }

  console.log(`outputs: ${outputs.length}, live rounds: ${rounds.length}`);
  const keys = Object.keys(tally);
  if (keys.length === 0) console.log("NOTHING would change — the new derivation agrees with every stamp on the board today.");
  for (const k of keys.sort()) console.log(`  ${tally[k]}  ${k}`);
  if (examples.length) { console.log("\nexamples:"); for (const e of examples) console.log(e); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
