// Oct 14 2026 (Jordan): "Can you re-run Janice's scripts through the new
// engine. Don't approve them yet I just want them re-ran." Fresh drafts (not
// revisions) of her October scripts with the current engine: Skits, the
// audience psychology, the creative identity, then the automatic check and
// fix. Each becomes a NEW version on the same script, in review; the old
// version stays in its history. Nothing is approved or shared.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct14/redraft-janice-october.ts [--apply]
import { prisma } from "@/lib/prisma";
const ENROLLMENT = "cmue43gsi0044k404p9zwxruh";
async function main() {
  const apply = process.argv.includes("--apply");
  const e = await prisma.contentEnrollment.findUnique({ where: { id: ENROLLMENT }, select: { clientId: true, overridesJson: true } });
  const c = await prisma.client.findUnique({ where: { id: e!.clientId }, select: { name: true } });
  if (c?.name !== "Janice Pigga") throw new Error("Not Janice Pigga's program — stopping.");
  console.log("video style:", JSON.parse(e!.overridesJson ?? "{}").videoStyle ?? "DIRECT");
  const oct = await prisma.contentMonth.findFirst({ where: { enrollmentId: ENROLLMENT, monthKey: "2026-10" }, select: { id: true } });
  const scripts = await prisma.contentScript.findMany({ where: { enrollmentId: ENROLLMENT, monthId: oct!.id, historical: false }, select: { id: true, title: true, status: true, topicId: true, interviewId: true, callRecordId: true } as never, orderBy: { createdAt: "asc" } }) as unknown as { id: string; title: string; status: string; topicId: string | null; interviewId: string | null; callRecordId: string | null }[];
  for (const s of scripts) console.log(`- ${s.status} · ${s.title} · ${s.interviewId ? "written answers" : "call"}`);
  if (!apply) { console.log("DRY RUN"); return; }
  const gen = await import("@/lib/contentGeneration");
  for (const s of scripts) {
    if (!["INTERNAL_REVIEW", "DRAFT"].includes(s.status)) { console.log(`skip (${s.status}): ${s.title}`); continue; }
    try {
      const r = s.interviewId
        ? await gen.generateScriptFromInterview(s.interviewId, "info@realtourpilot.com", { unattended: false })
        : await gen.generateScriptForTopic({ topicId: s.topicId!, monthId: oct!.id, requestedBy: "info@realtourpilot.com", unattended: false, callRecordId: s.callRecordId });
      const after = await prisma.contentScript.findUnique({ where: { id: r.scriptId }, select: { status: true, currentVersionId: true, approvedVersionId: true } });
      const v = await prisma.contentScriptVersion.findUnique({ where: { id: after!.currentVersionId! }, select: { versionNo: true, title: true, body: true, validationJson: true } as never }) as unknown as { versionNo: number; title: string; body: string; validationJson: string | null };
      let check = "";
      try { const j = JSON.parse(v.validationJson ?? "{}"); check = JSON.stringify(j.judge ?? j.check ?? {}).slice(0, 300); } catch { /* */ }
      console.log(`\n=== v${v.versionNo} [${after!.status}${after!.approvedVersionId ? ", has an approved version" : ""}] ${v.title}\n${v.body}\n--- check: ${check}`);
    } catch (err) { console.log(`FAILED ${s.title}: ${err instanceof Error ? err.message : String(err)}`); }
  }
}
main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
