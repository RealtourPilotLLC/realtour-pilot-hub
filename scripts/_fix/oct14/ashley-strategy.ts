// Oct 14 2026 (Jordan): "Here's Ashley Brunner's content strategy." Imports the
// .docx as her strategy, approves it, releases it to her portal WITHOUT the
// strategy-ready email (Jordan: everyone already has their strategy), creates
// her pillars, builds her creative identity and queues her topic bank.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct14/ashley-strategy.ts <file.docx> [--apply]
import { readFileSync } from "fs";
import { prisma } from "@/lib/prisma";
const ENROLLMENT = "cmt7msava000e9kg1zvggxqm9";
const BY = "info@realtourpilot.com";
async function main() {
  const apply = process.argv.includes("--apply");
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) throw new Error("Pass the .docx");
  const e = await prisma.contentEnrollment.findUnique({ where: { id: ENROLLMENT }, select: { clientId: true, status: true } });
  const c = await prisma.client.findUnique({ where: { id: e!.clientId }, select: { name: true } });
  if (c?.name !== "Ashley Brunner") throw new Error("Not Ashley Brunner's program — stopping.");
  const { extractDocumentText } = await import("@/lib/documentText");
  const d = await extractDocumentText(readFileSync(file), "Ashley_Brunner_2026_Social_Content_Strategy.docx");
  if (!d.ok) throw new Error(d.message);
  const cs = await import("@/lib/contentStrategy");
  const { structuredFromText } = cs as unknown as { structuredFromText?: (t: string) => { parsed: { structureVersion: string; contentPillars?: { pillars: { name: string }[] } } } };
  if (structuredFromText) { const p = structuredFromText(d.text).parsed; console.log("parsed:", p.structureVersion, "pillars:", p.contentPillars?.pillars.map((x) => x.name).join(" | ")); }
  if (!apply) { console.log("DRY RUN"); return; }
  const imp = await cs.importStrategyVersion({ enrollmentId: ENROLLMENT, text: d.text, fileName: "Ashley_Brunner_2026_Social_Content_Strategy.docx", createdBy: BY });
  console.log(`imported v${imp.versionNo} (${imp.structureVersion}, ${imp.pillarCount} pillars)`);
  const a = await cs.approveStrategyVersion(imp.versionId, BY);
  console.log(`approved; ${a.pillarsCreated} pillars created`);
  await cs.releaseStrategyVersion(imp.versionId, BY);
  console.log("released to her portal (no email)");
  const { deriveCreativeIdentity } = await import("@/lib/creativeIdentity");
  const ci = await deriveCreativeIdentity(ENROLLMENT, { requestedBy: BY, unattended: false });
  console.log("creative identity:", ci.ok ? "built" : ci.reason);
  const { queueTopicRefresh } = await import("@/lib/contentTopics");
  const bankTopics = await prisma.contentTopic.count({ where: { enrollmentId: ENROLLMENT, status: { notIn: ["REJECTED", "ARCHIVED"] } } });
  const q = await queueTopicRefresh({ enrollmentId: ENROLLMENT, kind: bankTopics ? "REFRESH" : "BANK", requestedBy: BY, reason: "initial bank after strategy approval" } as never);
  console.log("topic bank queued:", JSON.stringify(q).slice(0, 200));
}
main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
