// READ-ONLY probe. portalInterview resolves the script for ANY topic; the
// topic bank (contentTopics.topicBankByPillar) lists only
// `status notIn [REJECTED, ARCHIVED]`. How many live interviews hang off a
// topic that is NOT on the bank, and would any of them claim a released
// script on a card the client cannot see?
import { prisma } from "../../../src/lib/prisma";

const OFF_BANK = ["REJECTED", "ARCHIVED"];

async function main() {
  const interviews = await prisma.contentInterview.findMany({ select: { id: true, enrollmentId: true, topicId: true, status: true, answeredCount: true, submittedAt: true } });
  const topics = await prisma.contentTopic.findMany({ select: { id: true, title: true, status: true, approvalState: true, enrollmentId: true } });
  const byId = new Map(topics.map((t) => [t.id, t]));
  const scripts = await prisma.contentScript.findMany({ where: { historical: false }, select: { id: true, topicId: true, enrollmentId: true, releaseState: true, sharedVersionId: true, updatedAt: true } });

  const offBank = interviews.filter((iv) => { const t = byId.get(iv.topicId); return !t || OFF_BANK.includes(t.status); });
  const offBankApproval = interviews.filter((iv) => { const t = byId.get(iv.topicId); return t && !OFF_BANK.includes(t.status) && t.approvalState && OFF_BANK.includes(t.approvalState); });
  console.log(`ContentInterview rows: ${interviews.length}`);
  console.log(`  whose topic is missing or status REJECTED/ARCHIVED (NOT on the bank): ${offBank.length}`);
  console.log(`  whose topic is on the bank but approvalState is REJECTED/ARCHIVED: ${offBankApproval.length}`);

  const released = (topicId: string, enrollmentId: string) => {
    const s = scripts.filter((x) => x.topicId === topicId && x.enrollmentId === enrollmentId).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    return !!(s && s.releaseState === "released" && s.sharedVersionId);
  };
  for (const iv of offBank.slice(0, 10)) {
    const t = byId.get(iv.topicId);
    console.log(`  · interview ${iv.id} topic=${iv.topicId} "${t?.title ?? "(topic row gone)"}" status=${t?.status ?? "-"} approval=${t?.approvalState ?? "-"} ivStatus=${iv.status} answered=${iv.answeredCount} script.stage would be released: ${released(iv.topicId, iv.enrollmentId)}`);
  }

  // Topics that are off the bank AND carry a non-historical script.
  const withScript = topics.filter((t) => OFF_BANK.includes(t.status) && scripts.some((s) => s.topicId === t.id));
  console.log(`\nOff-bank topics carrying a live (non-historical) script: ${withScript.length}`);
  for (const t of withScript.slice(0, 10)) console.log(`  · ${t.id} "${t.title}" status=${t.status} approval=${t.approvalState}`);

  const archivedTopics = topics.filter((t) => OFF_BANK.includes(t.status));
  console.log(`\nTopics total ${topics.length}; off the bank ${archivedTopics.length}`);
}
main().then(() => prisma.$disconnect());
