export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 23 2026). Jordan: "Turn on Brief, and if Erica hasn't
// approved the video yet, then run it through Topaz."
//   1. The photographer brief switched ON through the Settings page's own
//      action (settings/actions.savePhotographerBrief, as Jordan), keeping the
//      send time (6 PM ET the business day before).
//   2. Erica Walker's 99 Bridge St Video 5 ("Your Lot Should Decide Your Floor
//      Plan"), published to her portal this morning without the 1080p pass
//      (the "already 1080p" rule, now off): only if she has made no decision
//      on it, back through the pass (topazJobs.retryTopazJob, force-pass).
// Dry run by default; --apply writes.
// ---------------------------------------------------------------------------
import { installNextStubs, interceptModule } from "../_drill/_harness";
const APPLY = process.argv.includes("--apply");
const SUB = "cmvkvy0of0001l7087p1dgpun";
const JOB = "cmvkx96af0006l008gxmpgrv8";
let me: Record<string, unknown> | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => me : t[k]; } }),
);
installNextStubs();
async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const owner = await prisma.appUser.findFirstOrThrow({ where: { email: "info@realtourpilot.com" }, select: { id: true, email: true, name: true, role: true, permissions: true, status: true, teamMemberId: true, editorKey: true } });
  me = { ...owner, notificationsSeenAt: null, impersonating: false, realRole: owner.role, realName: owner.name };
  const row = await prisma.appSetting.findUnique({ where: { key: "photographer_brief" } });
  const cur = (() => { try { return JSON.parse(row?.value ?? "{}") as { enabled?: boolean; sendMinute?: number }; } catch { return {}; } })();
  const sendMinute = typeof cur.sendMinute === "number" ? cur.sendMinute : 1080;
  console.log(`brief now: ${JSON.stringify(cur)} → enabled true, sendMinute ${sendMinute}`);
  const decisions = await prisma.clientDecision.count({ where: { submissionId: SUB } });
  const job = await prisma.topazJob.findUniqueOrThrow({ where: { id: JOB }, select: { state: true, outputCheck: true } });
  console.log(`Erica V5: client decisions ${decisions} · 1080p job ${job.state}/${job.outputCheck}`);
  if (!APPLY) { console.log("DRY RUN: nothing written."); process.exit(0); }
  const { savePhotographerBrief } = await import("../../src/app/settings/actions");
  console.log(`brief: ${JSON.stringify(await savePhotographerBrief({ enabled: true, sendMinute }))}`);
  if (decisions > 0) { console.log("Erica has decided on it: not re-run."); process.exit(0); }
  const { retryTopazJob } = await import("../../src/lib/topazJobs");
  console.log(`Erica V5: ${JSON.stringify(await retryTopazJob(JOB))}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
