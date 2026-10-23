export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 23 2026). Jordan, on 46 Fayette St (Paul Zgalich), Video 2
// v3, approved 1:48 PM: "this should have went to Topaz." It skipped under the
// Oct 22 "already 1080p" rule (skipFinished1080p), which skips nearly every
// video (the editors export 1080p H.264/AAC). This switches that rule OFF in
// the Topaz settings (saveTopazSettings, the Settings page's own store) and
// sends the not-yet-sent video through the pass (topazJobs.retryTopazJob:
// back in the queue, force-pass). Erica's 99 Bridge St Video 5 also skipped
// but already went to her portal at 8:04 AM; it is listed, not touched.
// Dry run by default; --apply writes.
// ---------------------------------------------------------------------------
import { installNextStubs } from "../_drill/_harness";
installNextStubs();
const APPLY = process.argv.includes("--apply");
const FAYETTE_V3_JOB = "cmvl9jm8o0007l208jqxrla4c";
async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const { topazSettings, saveTopazSettings } = await import("../../src/lib/settings");
  const s = await topazSettings();
  console.log(`skip already-1080p now: ${s.skipFinished1080p} · pass enabled: ${s.enabled}`);
  const j = await prisma.topazJob.findUniqueOrThrow({ where: { id: FAYETTE_V3_JOB }, select: { state: true, outputCheck: true, resolution: true, submission: { select: { status: true, sentToClientAt: true, fileName: true } } } });
  console.log(`46 Fayette V2 v3: ${j.submission.fileName} ${j.submission.status} sent=${j.submission.sentToClientAt ?? "-"} · job ${j.state}/${j.outputCheck}/${j.resolution}`);
  if (!APPLY) { console.log("DRY RUN: would switch the rule off and send 46 Fayette V2 v3 through the pass. Add --apply."); process.exit(0); }
  const saved = await saveTopazSettings({ skipFinished1080p: false }, "info@realtourpilot.com (via Claude)");
  console.log(`saved: skip already-1080p = ${saved.skipFinished1080p}`);
  if (j.submission.sentToClientAt) { console.log("46 Fayette was sent meanwhile: not re-run."); process.exit(0); }
  const { retryTopazJob } = await import("../../src/lib/topazJobs");
  console.log(`46 Fayette V2 v3: ${JSON.stringify(await retryTopazJob(FAYETTE_V3_JOB))}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
