// Oct 12 2026: include the 15 transcript jobs queued before the call processor
// was switched on (John Collins, Janice Pigga, Joe Sutow, Erica Walker, Arielle
// Roemer, Kristin Ciarmella) — same writes as settings/calendlyActions
// setTranscriptBacklogAction("include"). Internal only; results are proposals.
import { prisma } from "../../../src/lib/prisma";
(async () => {
  const tj = await import("../../../src/lib/transcriptJobs");
  const { setAutomationConfigField } = await import("../../../src/lib/programAutomation");
  const before: any = await tj.transcriptQueueBatch();
  const first = before.backlog.firstSwitchedOnAt ?? (before.backlog.source === "pinned" || before.backlog.source === "switch_on" ? before.backlog.cutoff : null);
  if (!before.backlog.firstSwitchedOnAt && first) await setAutomationConfigField("transcript_jobs", tj.FIRST_ON_FIELD, new Date(first).toISOString(), "info@realtourpilot.com", "transcript_first_switch_on");
  await setAutomationConfigField("transcript_jobs", tj.BACKLOG_FIELD, tj.INCLUDE_BACKLOG, "info@realtourpilot.com", "transcript_backlog_choice");
  const after: any = await tj.transcriptQueueBatch();
  console.log({ heldBacklogBefore: before.heldBacklog, heldBacklog: after.heldBacklog, runnableNow: after.runnableNow, heldScope: after.heldScope });
  await prisma.$disconnect();
})().catch((e) => { console.error("ERR", e?.message); process.exit(1); });
