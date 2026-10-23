export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 23 2026). Jordan: "Paid Photo QC should be off. Only using
// the free version. I don't need a paid QC, only paid fixes through AutoHDR."
//
// The stored house setting (AppSetting photo_delivery:settings) has
// paidQcAuto true and qcEnabled false. The code now reads both as off
// whatever is stored (settings.PAID_QC_OFF), and the paid engine refuses on
// its own; this puts the stored value in line, through the app's own
// settings path: the owner's Save on Photo Delivery settings
// (actions.saveSettingsAction, as Jordan), with only the two paid QC switches
// set off. Nothing else in the setting changes: the free photo check, the
// AutoHDR fixes and their limits stay exactly as stored.
//
// Dry run (default; the database connection is read-only): prints what is
// stored and what the save would store. Nothing is sent to anyone.
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct23-paid-qc-off.ts
// Write it:
//   … scripts/_live/oct23-paid-qc-off.ts --apply
// ---------------------------------------------------------------------------
import { installNextStubs, interceptModule } from "../_drill/_harness";

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}

let me: Record<string, unknown> | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => me : t[k]; } }),
);
installNextStubs();

const KEY = "photo_delivery:settings";
const PAID = ["qcEnabled", "paidQcAuto"] as const;
/** The free check and the AutoHDR fixes: shown before and after, so the run proves they did not move. */
const KEPT = ["enabled", "freeCheck", "warpCv", "warpCompareOriginal", "freeCoverage", "afterDeliveryCheck", "fixRunnerEnabled", "autoFix", "fixTargetUsd", "fixMaxUsd", "autoFixDailyMaxCredits", "autoSubmit", "showAutohdrPhotos", "aryeoPush", "sameDayAutoDeliver", "qcShadow"] as const;

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const { getSetting } = await import("../../src/lib/settings");
  const { photoDeliverySettings } = await import("../../src/lib/photoDelivery/settings");
  const owner = await prisma.appUser.findFirstOrThrow({ where: { email: "info@realtourpilot.com" }, select: { id: true, email: true, name: true, role: true, permissions: true, status: true, teamMemberId: true, editorKey: true } });
  me = { ...owner, notificationsSeenAt: null, impersonating: false, realRole: owner.role, realName: owner.name };
  console.log(`=== ${APPLY ? "APPLY" : "DRY RUN (read-only connection)"} === acting as ${owner.name ?? owner.email} (${owner.role})`);

  const stored = await getSetting<Record<string, unknown>>(KEY, {});
  const read = await photoDeliverySettings();
  console.log("\nStored now (AppSetting photo_delivery:settings):");
  for (const k of PAID) console.log(`  ${k}: ${JSON.stringify(stored[k])}`);
  console.log("What the app reads now (PAID_QC_OFF):");
  for (const k of PAID) console.log(`  ${k}: ${JSON.stringify(read[k])}`);
  console.log("Kept as they are (free check, AutoHDR fixes, delivery):");
  for (const k of KEPT) console.log(`  ${k}: ${JSON.stringify(stored[k] ?? read[k])}`);

  const paidRuns = await prisma.photoQcRun.count({ where: { trigger: { not: "AUTOHDR_CHECK" }, status: "RUNNING" } });
  const paidAsks = await prisma.photoJob.count({ where: { qcRequestedAt: { not: null } } });
  console.log(`\nPaid QC runs still RUNNING: ${paidRuns} (none resumes: driveQc refuses). Jobs with an old paid QC request flag: ${paidAsks} (never picked up).`);

  const input = { qcEnabled: false, paidQcAuto: false };
  const already = PAID.every((k) => stored[k] === false);
  console.log(`\nWOULD SAVE through Photo Delivery settings (saveSettingsAction, as Jordan): ${JSON.stringify(input)}${already ? "  (already stored off: nothing to change)" : ""}`);
  if (!APPLY || already) {
    if (!APPLY) console.log("\nDRY RUN: nothing written. Re-run with --apply.");
    await prisma.$disconnect();
    return;
  }
  const { saveSettingsAction } = await import("../../src/app/ops/photo-delivery/actions");
  const r = await saveSettingsAction(input);
  console.log(`→ ${JSON.stringify(r)}`);
  const after = await getSetting<Record<string, unknown>>(KEY, {});
  for (const k of PAID) console.log(`  stored ${k}: ${JSON.stringify(after[k])}`);
  const moved = KEPT.filter((k) => JSON.stringify(after[k] ?? null) !== JSON.stringify(stored[k] ?? null) && stored[k] !== undefined);
  console.log(moved.length ? `  CHANGED UNEXPECTEDLY: ${moved.join(", ")}` : "  the free check, the fixes and delivery settings are unchanged");
  await prisma.$disconnect();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
