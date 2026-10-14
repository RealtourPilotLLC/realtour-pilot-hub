// Oct 14 2026: switch AI photo QC ON in shadow (advisory) mode after the
// phase 2 deploy (bcb1062). Shadow keeps every result advisory: nothing is
// held, blocked or sent to a client; Kyle gets one bell per gallery. Spends
// Anthropic API money only (about $2 a gallery), capped by the monthly QC
// budget. AutoHDR fixes stay OFF (fixRunnerEnabled) until Jordan approves a
// live paid test.
import { photoDeliverySettings, savePhotoDeliverySettings } from "@/lib/photoDelivery/settings";
async function main() {
  const before = await photoDeliverySettings();
  console.log("before", { qcEnabled: before.qcEnabled, qcShadow: before.qcShadow, fixRunnerEnabled: before.fixRunnerEnabled, monthlyQcBudgetUsd: before.monthlyQcBudgetUsd });
  const after = await savePhotoDeliverySettings({ qcEnabled: true, qcShadow: true }, "claude (Jordan: keep going until everything is deployed)");
  console.log("after", { qcEnabled: after.qcEnabled, qcShadow: after.qcShadow, fixRunnerEnabled: after.fixRunnerEnabled, maxBuildPhase: after.maxBuildPhase, monthlyQcBudgetUsd: after.monthlyQcBudgetUsd });
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
