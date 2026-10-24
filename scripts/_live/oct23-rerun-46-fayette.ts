export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 23 2026, evening). Jordan pressed "Run Topaz again" on
// 46 Fayette St (Video 2 of 4, v3) twice and no press reached the server (no
// request in the logs, no re-run record), so the job still holds the 1:51 PM
// render made on "Auto". This runs the same server action the button calls
// (deliveryRecoveryActions.rerunTopazAction), as Jordan, so the editor's
// original goes back through Topaz with his saved Settings ("Manual" since
// 4:38 PM). Dry run by default: prints the engine's own refusal check and the
// settings the render will use; --apply presses it.
// ---------------------------------------------------------------------------
import { installNextStubs, interceptModule } from "../_drill/_harness";

const APPLY = process.argv.includes("--apply");
const JOB = "cmvl9jm8o0007l208jqxrla4c"; // 46 Fayette St, Personal Branding Reel, Video 2 of 4, v3

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
  const { topazSettings } = await import("../../src/lib/settings");
  const s = await topazSettings();
  console.log(`=== ${APPLY ? "APPLY" : "DRY RUN"} ===`);
  console.log(`Settings the render will use: auto=${s.params.auto}, details=${s.params.details}, noise=${s.params.noise}, blur=${s.params.blur}, halo=${s.params.halo}, compression=${s.params.compression}, recover=${s.params.recover_original_detail_value}, bitrate=${s.videoBitrate}`);
  const { rerunTopazJobRefusal } = await import("../../src/lib/topazJobs");
  const refusal = await rerunTopazJobRefusal(JOB);
  console.log(`Engine check: ${refusal ?? "it may run"}`);
  if (!APPLY || refusal) process.exit(0);
  const { rerunTopazAction } = await import("../../src/app/ops/deliveryRecoveryActions");
  console.log(`→ ${JSON.stringify(await rerunTopazAction(JOB))}`);
  const j = await prisma.topazJob.findUniqueOrThrow({ where: { id: JOB }, select: { state: true, startedAt: true, resolution: true } });
  console.log(`Job now: ${JSON.stringify(j)}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
