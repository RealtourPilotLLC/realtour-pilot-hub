export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 23 2026, Jordan and Kyle's huddle, item 2). AutoHDR's plan
// went to 2,000 credits a month (from about 1,000), and Jordan: "we can be a
// little more lenient with the fixes that we do."
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct23-autohdr-plan-2000.ts           (dry run)
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct23-autohdr-plan-2000.ts --apply   (writes)
//
// What it does, owner settings only, through the settings pages' own stores:
//   · records the plan on the Credits page (credits.planCreditsPerMonth = 2000;
//     the hub never knew the plan size before);
//   · raises the automatic fix budget in proportion to the plan (2,000 / the
//     plan before, about 1,000 when it was never recorded): the usual target
//     per shoot (fixTargetUsd), the most per shoot (fixMaxUsd) and the daily
//     guard on automatic fixes (autoFixDailyMaxCredits). Photo Delivery
//     settings, owner only, exactly as if Jordan saved them there.
// What it does NOT change (reported, Jordan's call): Kyle's per-batch approval
// limit (adminCreditCap), the low-credit alert levels, dollars per credit,
// whether fixes run by themselves (autoFix), and the AutoHDR account itself
// (its "walkthrough reordering" switch stays as it is). Run twice, the second
// run changes nothing (the plan is already 2,000: a ratio of 1).
//
// The dry run proves the connection is read-only (a refused write) before
// reading anything. The database URL comes from the environment, else this
// checkout's .env, else DOTENV_PATH.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { installNextStubs } from "../_drill/_harness";

installNextStubs();
const APPLY = process.argv.includes("--apply");
const NEW_PLAN = 2000;
/** Jordan, Oct 23: "about 1,000" before; the hub never recorded it. */
const ASSUMED_OLD_PLAN = 1000;
const BY = "info@realtourpilot.com (via Claude, huddle Oct 23)";

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [path.resolve(__dirname, "../../.env"), process.env.DOTENV_PATH ?? ""]) {
    if (!file || !fs.existsSync(file)) continue;
    const m = fs.readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL not found.");
}

async function main() {
  const url = new URL(databaseUrl());
  if (!APPLY) url.searchParams.set("options", [url.searchParams.get("options"), "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  process.env.DATABASE_URL = url.toString();
  const { prisma } = await import("../../src/lib/prisma");
  if (!APPLY) {
    let refused = false;
    try {
      await prisma.appSetting.updateMany({ where: { key: "__oct23_plan_readonly_probe__" }, data: { value: "x" } });
    } catch (e) {
      refused = /read-only|25006/.test(String(e));
    }
    if (!refused) throw new Error("The read-only guard is NOT proven: refusing to continue the dry run.");
    console.log("dry run: the connection is read-only (a write was refused). Add --apply to write.\n");
  }
  const { creditThresholds, saveCreditThresholds } = await import("../../src/lib/photoDelivery/credits");
  const { photoDeliverySettings, savePhotoDeliverySettings } = await import("../../src/lib/photoDelivery/settings");
  const t = await creditThresholds();
  const s = await photoDeliverySettings();
  const oldPlan = t.planCreditsPerMonth ?? ASSUMED_OLD_PLAN;
  const ratio = NEW_PLAN / oldPlan;
  const money = (n: number) => Math.round(n * 100) / 100;
  const credits = (usd: number) => Math.floor(usd / t.usdPerCredit + 1e-9);
  const after = {
    fixTargetUsd: money(s.fixTargetUsd * ratio),
    fixMaxUsd: money(s.fixMaxUsd * ratio),
    autoFixDailyMaxCredits: Math.round(s.autoFixDailyMaxCredits * ratio),
  };
  const row = (label: string, before: string, next: string) => console.log(`  ${label.padEnd(44)} ${before.padEnd(26)} -> ${next}`);
  console.log(`AutoHDR plan: ${t.planCreditsPerMonth == null ? `not recorded (Jordan: about ${ASSUMED_OLD_PLAN.toLocaleString("en-US")})` : t.planCreditsPerMonth.toLocaleString("en-US")} -> ${NEW_PLAN.toLocaleString("en-US")} credits a month (ratio ${ratio.toFixed(2)})`);
  console.log(`dollars per credit (unchanged): $${t.usdPerCredit}\n`);
  console.log("  setting                                       before                     -> after");
  row("plan credits a month (Credits page)", t.planCreditsPerMonth == null ? "not recorded" : String(t.planCreditsPerMonth), String(NEW_PLAN));
  row("fix target per shoot (fixTargetUsd)", `$${s.fixTargetUsd} = ${credits(s.fixTargetUsd)} credits`, `$${after.fixTargetUsd} = ${credits(after.fixTargetUsd)} credits`);
  row("fix maximum per shoot (fixMaxUsd)", `$${s.fixMaxUsd} = ${credits(s.fixMaxUsd)} credits`, `$${after.fixMaxUsd} = ${credits(after.fixMaxUsd)} credits`);
  row("automatic fixes a day (autoFixDailyMaxCredits)", `${s.autoFixDailyMaxCredits} credits`, `${after.autoFixDailyMaxCredits} credits`);
  console.log("\n  unchanged (Jordan's call):");
  row("Kyle's per-batch approval limit (adminCreditCap)", `${s.adminCreditCap} credits`, "unchanged");
  row("low-credit alerts (warn / critical)", `${t.warn} / ${t.critical}`, "unchanged");
  row("fixes: run by themselves (autoFix) / runner on", `${s.autoFix} / ${s.fixRunnerEnabled}`, "unchanged");
  console.log("  AutoHDR account settings (walkthrough reordering)  unchanged: never touched by the hub");
  if (ratio === 1) {
    console.log("\nThe plan is already 2,000: nothing to change.");
    process.exit(0);
  }
  if (!APPLY) {
    console.log("\nDRY RUN: nothing written. Add --apply to save these through the settings pages' own stores.");
    process.exit(0);
  }
  const t2 = await saveCreditThresholds({ planCreditsPerMonth: NEW_PLAN }, BY);
  const s2 = await savePhotoDeliverySettings(after, BY);
  console.log(`\nsaved: plan ${t2.planCreditsPerMonth}; fixTargetUsd ${s2.fixTargetUsd}, fixMaxUsd ${s2.fixMaxUsd}, autoFixDailyMaxCredits ${s2.autoFixDailyMaxCredits}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
