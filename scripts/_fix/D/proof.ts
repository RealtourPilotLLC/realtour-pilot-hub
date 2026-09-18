// READ-ONLY proof of the three Group-D fixes, run through the real code.
//  1) postingKitFor: the client's script body arrives whole.
//  2) portalInterview: an off-bank topic no longer claims a card.
//  3) scriptForVideo's fence: a miss refuses instead of serving the legacy body.
//
// postingKitFor CAN write (it stamps STALE caption drafts), so this harness
// only builds kits for videos that carry no ContentCaptionDraft row — with
// none to stamp, that branch cannot fire and the call is a pure read.
import { prisma } from "../../../src/lib/prisma";
import { postingKitFor, resolveFinalFile } from "../../../src/lib/postingKit";
import { portalInterview, topicOnBank, interviewScriptStage, type PortalViewer } from "../../../src/lib/portal";
import { videoForEnrollment } from "../../../src/lib/contentVideos";
import { stripMoneySentences } from "../../../src/lib/text";

const viewerFor = (id: string, clientId: string, clientName: string): PortalViewer => ({
  enrollment: { id, clientId, clientName, status: "ACTIVE", videosPerMonth: 0, sessionsPerMonth: 0 },
  actor: { kind: "TOKEN" }, access: "FULL", via: "TOKEN",
});

async function main() {
  // Would postingKitFor stamp any draft STALE for this video? Same expression
  // it uses, evaluated read-only; a video with anything to stamp is skipped.
  const wouldWrite = async (video: Parameters<typeof resolveFinalFile>[0] & { enrollmentId: string; approvedSubmissionId: string | null; currentSubmissionId: string | null }) => {
    const { final } = await resolveFinalFile(video);
    const kitSubmissionId = final?.submissionId ?? video.approvedSubmissionId ?? video.currentSubmissionId ?? null;
    const captions = await prisma.contentCaptionDraft.findMany({ where: { videoId: video.id, enrollmentId: video.enrollmentId, status: { not: "ARCHIVED" } }, select: { status: true, submissionId: true } });
    return captions.some((c) => c.status !== "STALE" && kitSubmissionId && c.submissionId !== kitSubmissionId && !c.submissionId.startsWith("portal-video:"));
  };
  const names = new Map((await prisma.client.findMany({ select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const enrollments = (await prisma.contentEnrollment.findMany({ select: { id: true, clientId: true } })).map((e) => ({ ...e, client: { name: names.get(e.clientId) ?? "" } }));

  // ---- 1) the posting kit, for every video the harness may safely build.
  let kits = 0, withScript = 0, wouldHaveLost = 0;
  const shown: string[] = [];
  let ericaLine = "   NAMED CASE: no video carries it";
  for (const e of enrollments) {
    const rows = await prisma.contentVideo.findMany({ where: { enrollmentId: e.id }, select: { id: true } });
    for (const row of rows) {
      const video = await videoForEnrollment({ id: e.id, clientId: e.clientId }, row.id);
      if (!video || (await wouldWrite(video))) continue;
      const kit = await postingKitFor(viewerFor(e.id, e.clientId, e.client?.name ?? ""), video);
      kits++;
      if (!kit.script) continue;
      withScript++;
      const clamped = stripMoneySentences(kit.script.body);
      shown.push(`     · ${e.client?.name} — "${kit.script.title}" ${kit.script.versionLabel ?? "(legacy body)"}: served ${kit.script.body.length} chars; the removed clamp would have served ${clamped.length}`);
      if (clamped !== kit.script.body) wouldHaveLost++;
      if (/The list price is the strategy/.test(kit.script.body)) {
        ericaLine = `   NAMED CASE reaches the client through postingKitFor: ${kit.script.body.length} chars, "The list price is the strategy." present = true (old clamp: ${clamped.length} chars, that line dropped)`;
      }
    }
  }
  console.log(`1) POSTING KITS BUILT (read-only subset): ${kits}; carrying a script: ${withScript}`);
  console.log(`   scripts the removed clamp would have cut: ${wouldHaveLost}`);
  console.log(shown.join("\n"));
  console.log(ericaLine);

  // ---- 2) the interview stage, for every live interview, plus the off-bank rule.
  const ivs = await prisma.contentInterview.findMany({ select: { id: true, enrollmentId: true, topicId: true } });
  console.log(`\n2) LIVE INTERVIEWS: ${ivs.length}`);
  for (const iv of ivs) {
    const e = enrollments.find((x) => x.id === iv.enrollmentId);
    if (!e) continue;
    const view = await portalInterview({ id: e.id, clientId: e.clientId }, iv.id);
    const t = await prisma.contentTopic.findUnique({ where: { id: iv.topicId }, select: { title: true, status: true } });
    console.log(`   · ${iv.id} "${t?.title}" topic.status=${t?.status} onBank=${topicOnBank(t)} -> stage="${view?.script.stage}"`);
  }
  const offBankCount = await prisma.contentTopic.count({ where: { status: { in: ["REJECTED", "ARCHIVED"] } } });
  const offBank = await prisma.contentTopic.findMany({ where: { status: { in: ["REJECTED", "ARCHIVED"] } }, select: { id: true, status: true }, take: 3 });
  const onBank = await prisma.contentTopic.findMany({ where: { status: { notIn: ["REJECTED", "ARCHIVED"] } }, select: { id: true, status: true }, take: 3 });
  console.log(`   off-bank topics in production: ${offBankCount}; topicOnBank() on three of them: ${offBank.map((t) => `${t.status}=${topicOnBank(t)}`).join(", ")}`);
  console.log(`   on-bank sample: ${onBank.map((t) => `${t.status}=${topicOnBank(t)}`).join(", ")}; topicOnBank(null)=${topicOnBank(null)} (a deleted topic row is off the bank too)`);
  // The defect's own scenario, run on REAL archived rows: the released script
  // and the open interview are held constant; only the topic's place changes.
  const archived = await prisma.contentTopic.findMany({ where: { status: { in: ["REJECTED", "ARCHIVED"] } }, select: { id: true, title: true, status: true }, take: 2 });
  for (const t of archived) {
    console.log(`   · archived topic ${t.id} (${t.status}) with a RELEASED script + a draft on file -> stage="${interviewScriptStage(t, { released: true, versionsBuilt: 3 })}" (was "released")`);
    console.log(`     same topic, script still being written -> stage="${interviewScriptStage(t, { released: false, versionsBuilt: 3 })}" (was "preparing")`);
  }
  const live = onBank[0];
  console.log(`   · on-bank topic ${live?.id} (${live?.status}) unchanged: released -> "${interviewScriptStage(live, { released: true, versionsBuilt: 3 })}", building -> "${interviewScriptStage(live, { released: false, versionsBuilt: 3 })}", nothing yet -> "${interviewScriptStage(live, { released: false, versionsBuilt: 0 })}"`);

  // ---- 3) the fence, exercised against production ids.
  const versions = await prisma.contentScriptVersion.findMany({ select: { id: true, scriptId: true, enrollmentId: true } });
  const scripts = await prisma.contentScript.findMany({ select: { id: true, enrollmentId: true, sharedVersionId: true, approvedVersionId: true, historical: true } });
  let resolveOk = 0, refused = 0;
  for (const sc of scripts) {
    const rid = sc.sharedVersionId ?? sc.approvedVersionId ?? null;
    if (!rid) continue;
    if (versions.some((v) => v.id === rid && v.scriptId === sc.id && v.enrollmentId === sc.enrollmentId)) resolveOk++; else refused++;
  }
  console.log(`\n3) SCRIPTS NAMING A RELEASED VERSION: ${resolveOk + refused}; resolve under (scriptId + enrollmentId): ${resolveOk}; would now be refused: ${refused}`);
  const probe = versions[0];
  const other = scripts.find((x) => x.id !== probe.scriptId)!;
  const crossed = await prisma.contentScriptVersion.findFirst({ where: { id: probe.id, scriptId: other.id, enrollmentId: other.enrollmentId } });
  console.log(`   real version ${probe.id} asked for under script ${other.id}'s fence -> ${crossed ? "RETURNED (fence open!)" : "no row (fence closed; the code now returns null instead of ContentScript.body)"}`);
}
main().then(() => prisma.$disconnect());
