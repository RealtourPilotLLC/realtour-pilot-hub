// Oct 14 2026, Jordan: "from now on, any jobs uploaded to Dropbox and completed
// uploading I want sent to autoHDR using our current settings and then run
// through QC all automatically ... As long as QC is free, that's fine."
// Turns on the hub's AutoHDR intake and the free photo check; the paid Claude
// QC stops starting by itself (still available on a job's Run QC).
import { photoDeliverySettings, savePhotoDeliverySettings } from "@/lib/photoDelivery/settings";
async function main() {
  const before = await photoDeliverySettings();
  console.log("before", { autoSubmit: before.autoSubmit, freeCheck: before.freeCheck, paidQcAuto: before.paidQcAuto, qcEnabled: before.qcEnabled, autoSubmitFrom: before.autoSubmitFrom, fixRunnerEnabled: before.fixRunnerEnabled });
  const after = await savePhotoDeliverySettings({ autoSubmit: true, freeCheck: true, paidQcAuto: false }, "claude (for Jordan, Oct 14)");
  console.log("after", { autoSubmit: after.autoSubmit, freeCheck: after.freeCheck, paidQcAuto: after.paidQcAuto, qcEnabled: after.qcEnabled, autoSubmitFrom: after.autoSubmitFrom, fixRunnerEnabled: after.fixRunnerEnabled });
}
main().then(() => process.exit(0));
